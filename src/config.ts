/**
 * Credentials for the B2 account this server acts on behalf of.
 */
export interface B2Config {
  readonly applicationKeyId: string
  readonly applicationKey: string
}

/**
 * Raised when a required credential is absent from the environment.
 * Change this if config gains failure modes beyond "a variable is missing"
 * and callers need to tell them apart.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/** Environment variable holding the B2 application key ID. */
const KEY_ID_VAR = 'B2_APPLICATION_KEY_ID'

/** Environment variable holding the B2 application key secret. */
const KEY_VAR = 'B2_APPLICATION_KEY'

/**
 * Reads B2 credentials from the environment, failing loudly when one is
 * missing rather than letting the server start and return empty results.
 *
 * The env parameter exists so tests can supply a fake environment instead of
 * mutating the real process.env. Change this when a credential is added or
 * renamed, or when credentials start coming from somewhere other than the
 * environment.
 *
 * @throws ConfigError naming the missing variable. The message never contains
 * a credential value, so it is safe to surface to an MCP client.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): B2Config {
  const applicationKeyId = env[KEY_ID_VAR]
  const applicationKey = env[KEY_VAR]

  // An empty string is a half-configured environment, not a valid credential.
  if (!applicationKeyId) {
    throw new ConfigError(`Missing required environment variable ${KEY_ID_VAR}`)
  }
  if (!applicationKey) {
    throw new ConfigError(`Missing required environment variable ${KEY_VAR}`)
  }

  return { applicationKeyId, applicationKey }
}
