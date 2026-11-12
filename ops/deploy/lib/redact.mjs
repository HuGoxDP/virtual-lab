// ops/deploy/lib/redact.mjs
//
// Everything the pipeline prints goes through here (decision D-13): the deploy
// configuration is secrets, and a log is the one place they cannot land. The
// replacement set is the configured values themselves, longest first — a host
// that happens to be a substring of the domain must not leave a leak behind the
// shorter replacement — plus the key file's basename, which is a path on the
// worker and a hostname away.

/**
 * Builds the redactor for a parsed deploy configuration.
 *
 * @param {{DEPLOY_HOST: string, DEPLOY_DOMAIN: string, DEPLOY_USER: string,
 *          DEPLOY_KEY: string, DEPLOY_PATH?: string, DEPLOY_PORT?: string}} cfg
 * @returns {(text: string) => string}
 */
export function makeRedactor(cfg) {
  // Longest first: replacing the shorter of two overlapping values first would
  // leave a findable remainder of the longer one inside the replacement text.
  const entries = Object.entries(cfg ?? {})
    .filter(([key, value]) => key !== 'DEPLOY_KEY' && typeof value === 'string' && value.length > 0)
    .sort((a, b) => b[1].length - a[1].length);
  const keyName = String(cfg?.DEPLOY_KEY ?? '').split(/[\\/]/).pop() ?? '';

  /** The literal token in place of one configuration value. */
  const token = key => `<${key}>`;

  return function redact(text) {
    let out = String(text ?? '');
    for (const [key, value] of entries) {
      if (!out.includes(value)) continue;
      out = out.replaceAll(value, token(key));
    }
    // The key file's basename last: a longer value that contained it has already
    // been replaced, and what remains is the bare name.
    if (keyName.length > 2 && out.includes(keyName)) {
      out = out.replaceAll(keyName, '<DEPLOY_KEY>');
    }
    return out;
  };
}
