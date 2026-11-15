export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The migrations directory is malformed (names, numbering, missing files). */
export class MigrationLayoutError extends MigrationError {}

/** An applied migration changed on disk, vanished, or is out of order. */
export class MigrationDriftError extends MigrationError {}

/** A migration file breaks the static policy (see policy.ts). */
export class MigrationPolicyError extends MigrationError {}

/** `down` was requested in production without the explicit opt-in. */
export class ProductionDownBlockedError extends MigrationError {}
