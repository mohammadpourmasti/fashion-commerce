import { getDictionary } from "@/shared/i18n/server";
import { Container } from "@/shared/ui";

export async function SiteFooter() {
  const dict = await getDictionary();

  return (
    <footer className="mt-auto border-t border-line">
      <Container className="flex flex-col gap-2 py-10 text-sm text-muted sm:flex-row sm:items-center sm:justify-between">
        <p>
          © {dict.brand.name}. {dict.footer.rights}
        </p>
        <p>{dict.footer.note}</p>
      </Container>
    </footer>
  );
}
