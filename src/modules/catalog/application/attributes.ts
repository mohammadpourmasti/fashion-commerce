import { and, asc, eq, sql } from "drizzle-orm";

import { runInTransaction } from "@/shared/db/transaction";
import type { RequestContext } from "@/shared/kernel/authorization";

import { parseAttributeDefinition, type AttributeUsage, type AttributeValueType, type AxisKind } from "../domain/attributes";
import { parseKey, parseSwatch } from "../domain/codes";
import { invalid, issue, valid, type CatalogIssue } from "../domain/errors";
import { attributeChanged } from "../domain/events";
import { parseTranslations, type Translation, type TranslationInput } from "../domain/localization";
import { CATALOG_PERMISSIONS } from "../domain/permissions";
import { attributes, attributeTranslations, attributeValues, attributeValueTranslations, productAttributeValues } from "../infrastructure/schema";

import { mapUniqueViolations, notFound, replaceTranslations, requireRequiredLocale, type CatalogDeps, type CatalogResult, type TranslationTable } from "./support";

export interface AttributeValueView {
  readonly id: string;
  readonly key: string;
  readonly position: number;
  readonly swatchHex: string | null;
  readonly status: "active" | "archived";
  readonly labels: readonly Translation[];
}

export interface AttributeView {
  readonly id: string;
  readonly key: string;
  readonly usage: AttributeUsage;
  readonly valueType: AttributeValueType;
  readonly axisKind: AxisKind | null;
  readonly unit: string | null;
  readonly position: number;
  readonly status: "active" | "archived";
  readonly names: readonly Translation[];
  readonly values: readonly AttributeValueView[];
}

const NAMES: TranslationTable = {
  table: attributeTranslations,
  owner: attributeTranslations.attributeId,
  locale: attributeTranslations.locale,
  row: (attributeId, t) => ({ attributeId, locale: t.locale, name: t.name }),
  updates: [["name", "name"]],
};

const LABELS: TranslationTable = {
  table: attributeValueTranslations,
  owner: attributeValueTranslations.valueId,
  locale: attributeValueTranslations.locale,
  row: (valueId, t) => ({ valueId, locale: t.locale, label: t.name }),
  updates: [["label", "label"]],
};

function parseContent(kind: "attribute" | "value", translations: readonly TranslationInput[]): CatalogResult<Translation[]> {
  const parsed = parseTranslations(kind, translations);
  if (!parsed.ok) return parsed;
  const missing = requireRequiredLocale(parsed.value);
  return missing.length > 0 ? invalid(missing) : parsed;
}

const issuesOf = (...results: readonly { ok: boolean; issues?: readonly CatalogIssue[] }[]): CatalogIssue[] => results.flatMap((r) => (r.ok ? [] : [...(r.issues ?? [])]));

export function createAttributeService({ pool, now }: CatalogDeps) {
  const authorize = (ctx: RequestContext) => ctx.authorize(CATALOG_PERMISSIONS.taxonomyManage);

  async function setAttributeStatus(ctx: RequestContext, attributeId: string, status: "active" | "archived"): Promise<CatalogResult<{ attributeId: string }>> {
    await authorize(ctx);
    return runInTransaction(pool, async (tx) => {
      const [row] = await tx.db.select({ id: attributes.id, status: attributes.status }).from(attributes).where(eq(attributes.id, attributeId)).for("update").limit(1);
      if (!row) return notFound("attributeId");
      if (row.status === status) return valid({ attributeId: row.id });
      await tx.db.update(attributes).set({ status, updatedAt: now() }).where(eq(attributes.id, row.id));
      await tx.events.add(attributeChanged(row.id));
      return valid({ attributeId: row.id });
    });
  }

  async function setValueStatus(ctx: RequestContext, valueId: string, status: "active" | "archived"): Promise<CatalogResult<{ valueId: string }>> {
    await authorize(ctx);
    return runInTransaction(pool, async (tx) => {
      // Locks the value and its attribute, so a concurrent attribute archive cannot interleave
      // with restoring the value (which requires the attribute to be active).
      const [row] = await tx.db
        .select({ id: attributeValues.id, attributeId: attributeValues.attributeId, status: attributeValues.status, attributeStatus: attributes.status })
        .from(attributeValues)
        .innerJoin(attributes, eq(attributes.id, attributeValues.attributeId))
        .where(eq(attributeValues.id, valueId))
        .for("update")
        .limit(1);
      if (!row) return notFound("valueId");
      if (row.status === status) return valid({ valueId: row.id });
      if (status === "active" && row.attributeStatus !== "active") return invalid([issue("attribute_archived", "attributeId")]);
      await tx.db.update(attributeValues).set({ status, updatedAt: now() }).where(eq(attributeValues.id, row.id));
      await tx.events.add(attributeChanged(row.attributeId, row.id));
      return valid({ valueId: row.id });
    });
  }

  return {
    /** Usage, value type, axis kind and key are fixed at creation (ADR-024/026). */
    async create(
      ctx: RequestContext,
      input: { key: string; usage: string; valueType: string; axisKind?: string | null; unit?: string | null; translations: readonly TranslationInput[] },
    ): Promise<CatalogResult<{ attributeId: string }>> {
      await authorize(ctx);
      const definition = parseAttributeDefinition(input);
      const content = parseContent("attribute", input.translations);
      if (!definition.ok || !content.ok) return invalid(issuesOf(definition, content));

      return mapUniqueViolations(() =>
        runInTransaction(pool, async (tx) => {
          const [existing] = await tx.db.select({ id: attributes.id }).from(attributes).where(eq(attributes.key, definition.value.key)).limit(1);
          if (existing) return invalid([issue("key_taken", "key")]);
          const [next] = await tx.db.select({ n: sql<number>`coalesce(max(${attributes.position}), -1) + 1` }).from(attributes);
          const at = now();
          const [row] = await tx.db
            .insert(attributes)
            .values({ ...definition.value, position: Number(next?.n ?? 0), createdAt: at, updatedAt: at })
            .returning({ id: attributes.id });
          if (!row) throw new Error("attribute insert returned no row");
          await replaceTranslations(tx.db, NAMES, row.id, content.value);
          await tx.events.add(attributeChanged(row.id));
          return valid({ attributeId: row.id });
        }),
      );
    },

    /**
     * Replaces the names and, for number attributes, the unit (`undefined` keeps it, `null`
     * clears it). The unit cannot change once any product stores a value for the attribute: the
     * stored numbers would silently change meaning. The definition itself never changes.
     */
    async update(ctx: RequestContext, input: { attributeId: string; translations?: readonly TranslationInput[]; unit?: string | null }): Promise<CatalogResult<{ attributeId: string }>> {
      await authorize(ctx);
      const content = input.translations ? parseContent("attribute", input.translations) : null;
      if (content && !content.ok) return content;

      return runInTransaction(pool, async (tx) => {
        const [row] = await tx.db.select().from(attributes).where(eq(attributes.id, input.attributeId)).for("update").limit(1);
        if (!row) return notFound("attributeId");
        let unit = row.unit;
        if (input.unit !== undefined) {
          const checked = parseAttributeDefinition({ key: row.key, usage: row.usage, valueType: row.valueType, axisKind: row.axisKind, unit: input.unit });
          if (!checked.ok) return checked;
          if (checked.value.unit !== row.unit) {
            const [used] = await tx.db.select({ id: productAttributeValues.id }).from(productAttributeValues).where(eq(productAttributeValues.attributeId, row.id)).limit(1);
            if (used) return invalid([issue("attribute_in_use", "unit")]);
          }
          unit = checked.value.unit;
        }
        if (content) await replaceTranslations(tx.db, NAMES, row.id, content.value);
        await tx.db.update(attributes).set({ unit, updatedAt: now() }).where(eq(attributes.id, row.id));
        await tx.events.add(attributeChanged(row.id));
        return valid({ attributeId: row.id });
      });
    },

    /** Archived attributes stay on existing products but cannot be newly used. Idempotent. */
    archive: (ctx: RequestContext, input: { attributeId: string }) => setAttributeStatus(ctx, input.attributeId, "archived"),
    restore: (ctx: RequestContext, input: { attributeId: string }) => setAttributeStatus(ctx, input.attributeId, "active"),

    /** A new value at the end of a select attribute's values. The attribute must be active. */
    async createValue(
      ctx: RequestContext,
      input: { attributeId: string; key: string; translations: readonly TranslationInput[]; swatchHex?: string | null },
    ): Promise<CatalogResult<{ valueId: string }>> {
      await authorize(ctx);
      const key = parseKey("value", input.key);
      const swatch = parseSwatch(input.swatchHex);
      const content = parseContent("value", input.translations);
      if (!key.ok || !swatch.ok || !content.ok) return invalid(issuesOf(key, swatch, content));

      return mapUniqueViolations(() =>
        runInTransaction(pool, async (tx) => {
          const [attribute] = await tx.db.select().from(attributes).where(eq(attributes.id, input.attributeId)).for("share").limit(1);
          if (!attribute) return notFound("attributeId");
          if (attribute.valueType !== "select") return invalid([issue("attribute_type_mismatch", "attributeId", { expected: "select" })]);
          if (attribute.status !== "active") return invalid([issue("attribute_archived", "attributeId")]);
          const [existing] = await tx.db
            .select({ id: attributeValues.id })
            .from(attributeValues)
            .where(and(eq(attributeValues.attributeId, attribute.id), eq(attributeValues.key, key.value)))
            .limit(1);
          if (existing) return invalid([issue("key_taken", "key")]);
          const [next] = await tx.db
            .select({ n: sql<number>`coalesce(max(${attributeValues.position}), -1) + 1` })
            .from(attributeValues)
            .where(eq(attributeValues.attributeId, attribute.id));
          const at = now();
          const [row] = await tx.db
            .insert(attributeValues)
            .values({ attributeId: attribute.id, key: key.value, swatchHex: swatch.value, position: Number(next?.n ?? 0), createdAt: at, updatedAt: at })
            .returning({ id: attributeValues.id });
          if (!row) throw new Error("attribute value insert returned no row");
          await replaceTranslations(tx.db, LABELS, row.id, content.value);
          await tx.events.add(attributeChanged(attribute.id, row.id));
          return valid({ valueId: row.id });
        }),
      );
    },

    /** Replaces labels and/or the swatch (`undefined` keeps it, `null` clears it). The key is immutable. */
    async updateValue(
      ctx: RequestContext,
      input: { valueId: string; translations?: readonly TranslationInput[]; swatchHex?: string | null },
    ): Promise<CatalogResult<{ valueId: string }>> {
      await authorize(ctx);
      const content = input.translations ? parseContent("value", input.translations) : null;
      const swatch = input.swatchHex === undefined ? null : parseSwatch(input.swatchHex);
      if ((content && !content.ok) || (swatch && !swatch.ok)) return invalid(issuesOf(content ?? { ok: true }, swatch ?? { ok: true }));

      return runInTransaction(pool, async (tx) => {
        const [row] = await tx.db.select().from(attributeValues).where(eq(attributeValues.id, input.valueId)).for("update").limit(1);
        if (!row) return notFound("valueId");
        if (content?.ok) await replaceTranslations(tx.db, LABELS, row.id, content.value);
        await tx.db
          .update(attributeValues)
          .set({ swatchHex: swatch?.ok ? swatch.value : row.swatchHex, updatedAt: now() })
          .where(eq(attributeValues.id, row.id));
        await tx.events.add(attributeChanged(row.attributeId, row.id));
        return valid({ valueId: row.id });
      });
    },

    /** Sets the order of all values of an attribute; the list must name each value exactly once. */
    async reorderValues(ctx: RequestContext, input: { attributeId: string; orderedIds: readonly string[] }): Promise<CatalogResult<{ changed: number }>> {
      await authorize(ctx);
      return runInTransaction(pool, async (tx) => {
        const [attribute] = await tx.db.select({ id: attributes.id }).from(attributes).where(eq(attributes.id, input.attributeId)).for("update").limit(1);
        if (!attribute) return notFound("attributeId");
        const rows = await tx.db.select({ id: attributeValues.id, position: attributeValues.position }).from(attributeValues).where(eq(attributeValues.attributeId, attribute.id));
        const current = new Map(rows.map((r) => [r.id, r.position]));
        const unique = new Set(input.orderedIds);
        if (unique.size !== input.orderedIds.length || unique.size !== current.size || input.orderedIds.some((id) => !current.has(id))) {
          return invalid([issue("invalid_order", "orderedIds", { expected: current.size })]);
        }
        const at = now();
        let changed = 0;
        for (const [position, id] of input.orderedIds.entries()) {
          if (current.get(id) === position) continue;
          await tx.db.update(attributeValues).set({ position, updatedAt: at }).where(eq(attributeValues.id, id));
          changed += 1;
        }
        if (changed > 0) await tx.events.add(attributeChanged(attribute.id));
        return valid({ changed });
      });
    },

    /** Archived values stay where they are used but cannot be newly chosen. Idempotent. */
    archiveValue: (ctx: RequestContext, input: { valueId: string }) => setValueStatus(ctx, input.valueId, "archived"),
    /** Refused while the attribute itself is archived. Idempotent. */
    restoreValue: (ctx: RequestContext, input: { valueId: string }) => setValueStatus(ctx, input.valueId, "active"),

    /** Every attribute with its names and values (admin view, archived included). */
    async list(ctx: RequestContext): Promise<AttributeView[]> {
      await ctx.authorize(CATALOG_PERMISSIONS.productsRead);
      const rows = await runInTransaction(
        pool,
        async (tx) => ({
          attributes: await tx.db.select().from(attributes).orderBy(asc(attributes.position), asc(attributes.key)),
          names: await tx.db.select().from(attributeTranslations).orderBy(asc(attributeTranslations.locale)),
          values: await tx.db.select().from(attributeValues).orderBy(asc(attributeValues.position), asc(attributeValues.key)),
          labels: await tx.db.select().from(attributeValueTranslations).orderBy(asc(attributeValueTranslations.locale)),
        }),
        { isolation: "repeatable read" },
      );
      const translation = (locale: string, name: string): Translation => ({ locale: locale as Translation["locale"], name, slug: null, description: "", seoTitle: null, seoDescription: null });
      const group = <T, K>(items: readonly T[], keyOf: (item: T) => K) => {
        const map = new Map<K, T[]>();
        for (const item of items) map.set(keyOf(item), [...(map.get(keyOf(item)) ?? []), item]);
        return map;
      };
      const names = group(rows.names, (n) => n.attributeId);
      const labels = group(rows.labels, (l) => l.valueId);
      const values = group(rows.values, (v) => v.attributeId);
      return rows.attributes.map((a) => ({
        id: a.id,
        key: a.key,
        usage: a.usage,
        valueType: a.valueType,
        axisKind: a.axisKind,
        unit: a.unit,
        position: a.position,
        status: a.status as AttributeView["status"],
        names: (names.get(a.id) ?? []).map((n) => translation(n.locale, n.name)),
        values: (values.get(a.id) ?? []).map((v) => ({
          id: v.id,
          key: v.key,
          position: v.position,
          swatchHex: v.swatchHex,
          status: v.status as AttributeValueView["status"],
          labels: (labels.get(v.id) ?? []).map((l) => translation(l.locale, l.label)),
        })),
      }));
    },
  };
}

export type AttributeService = ReturnType<typeof createAttributeService>;
