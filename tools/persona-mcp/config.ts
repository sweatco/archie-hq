/**
 * Persona configuration for the test-persona tools.
 *
 * The file names a workspace and its members, so it lives outside the repository. It never
 * holds a secret: each secret field is a reference that `secrets.ts` resolves at run time.
 * Pure functions only — CLI mains read the file and pass its text in.
 */

import { z } from 'zod';

export type SecretReference =
  | { kind: 'keychain'; service: string; account: string }
  | { kind: 'op'; vault: string; item: string; section?: string; field: string }
  | { kind: 'env'; name: string };

const SECRET_REFERENCE_FORMS =
  'op://<vault>/<item>/<field>, keychain:<service>/<account> or env:<NAME>';

// `op://` is 1Password's own secret-reference syntax, so the same string works with `op read`.
const SECRET_REFERENCE =
  /^(?:keychain:([^/\s]+)\/(\S+)|op:\/\/([^/]+)\/([^/]+)\/(?:([^/]+)\/)?([^/]+)|env:([A-Z][A-Z0-9_]*))$/;

export function parseSecretReference(reference: string): SecretReference {
  const match = SECRET_REFERENCE.exec(reference);
  if (!match) throw new Error(`expected a secret reference: ${SECRET_REFERENCE_FORMS}`);
  const [, service, account, vault, item, section, field, name] = match;
  if (service !== undefined && account !== undefined) return { kind: 'keychain', service, account };
  if (vault !== undefined && item !== undefined && field !== undefined) {
    return { kind: 'op', vault, item, ...(section === undefined ? {} : { section }), field };
  }
  return { kind: 'env', name: name ?? '' };
}

const secretReference = z
  .string()
  .regex(SECRET_REFERENCE, `expected ${SECRET_REFERENCE_FORMS}, never the secret`);
const slackUserId = z.string().regex(/^[UW][A-Z0-9]{6,}$/, 'expected a Slack user ID');
const httpsUrl = z.string().url().startsWith('https://', 'expected an https:// URL');

const personaSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9-]*$/, 'expected a lowercase key such as "alice"'),
    slackUserId,
    token: secretReference,
  })
  .strict();

const personaConfigSchema = z
  .object({
    environment: z
      .string()
      .min(1)
      .refine((name) => !/prod/i.test(name), 'persona tools never target production'),
    teamId: z.string().regex(/^T[A-Z0-9]{6,}$/, 'expected a Slack team ID'),
    /** Absent until Archie is installed in the workspace; checks that need Archie are skipped. */
    archieBotUserId: slackUserId.optional(),
    /** Base URL of the instance's task API, used to observe tasks. */
    archieApiUrl: z.string().url().optional(),
    /** The instance's Slack webhook endpoint, used for signed synthetic requests. */
    slackWebhookUrl: z.string().url().optional(),
    signingSecret: secretReference.optional(),
    personaApp: z
      .object({ clientId: z.string().min(1), clientSecret: secretReference, redirectUrl: httpsUrl })
      .strict(),
    /** A public channel that every persona and Archie are members of; probes and recipes post here. */
    probeChannelId: z
      .string()
      .regex(/^C[A-Z0-9]{6,}$/, 'expected a public channel ID')
      .optional(),
    personas: z.array(personaSchema).min(1),
  })
  .strict()
  .superRefine((config, context) => {
    for (const field of ['key', 'slackUserId'] as const) {
      const values = config.personas.map((persona) => persona[field]);
      const duplicate = values.find((value, index) => values.indexOf(value) !== index);
      if (duplicate !== undefined) {
        context.addIssue({ code: 'custom', message: `duplicate persona ${field}: ${duplicate}` });
      }
    }
  });

export type PersonaConfig = z.infer<typeof personaConfigSchema>;
export type Persona = PersonaConfig['personas'][number];

/** Parse the config file's text, reporting every problem at once. */
export function parsePersonaConfig(configText: string): PersonaConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(configText);
  } catch (error) {
    throw new Error(`persona config is not valid JSON: ${(error as Error).message}`, {
      cause: error,
    });
  }
  const parsed = personaConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new Error(`persona config is invalid:\n${problems.join('\n')}`);
  }
  return parsed.data;
}

export function findPersona(config: PersonaConfig, key: string): Persona {
  const persona = config.personas.find((candidate) => candidate.key === key);
  if (!persona) {
    const known = config.personas.map((candidate) => candidate.key).join(', ');
    throw new Error(`unknown persona "${key}" (configured: ${known})`);
  }
  return persona;
}

export type EnvLike = Record<string, string | undefined>;

/** `ARCHIE_PERSONAS_CONFIG` beats the per-user default, so a worktree never needs its own copy. */
export function resolveConfigPath(env: EnvLike, homeDirectory: string): string {
  return env.ARCHIE_PERSONAS_CONFIG || `${homeDirectory}/.config/archie-personas/config.json`;
}

/** What a token's `auth.test` must match before any tool acts with it. */
export type IdentityCheck =
  { ok: true } | { ok: false; reason: 'wrong_workspace' | 'wrong_member'; detail: string };

/**
 * Decide whether a token belongs to the configured workspace and persona.
 * This is the guard that keeps a mistyped or misfiled token from acting somewhere else.
 */
export function checkTokenIdentity(
  identity: { teamId: string | undefined; userId: string | undefined },
  expected: { teamId: string; persona: Persona },
): IdentityCheck {
  if (identity.teamId !== expected.teamId) {
    return {
      ok: false,
      reason: 'wrong_workspace',
      detail: `token for "${expected.persona.key}" belongs to workspace ${identity.teamId ?? 'unknown'}, not the configured ${expected.teamId}`,
    };
  }
  if (identity.userId !== expected.persona.slackUserId) {
    return {
      ok: false,
      reason: 'wrong_member',
      detail: `token for "${expected.persona.key}" belongs to member ${identity.userId ?? 'unknown'}, not the configured ${expected.persona.slackUserId}`,
    };
  }
  return { ok: true };
}
