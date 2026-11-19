import { SECRET_KEY } from '../util/redact.js';

const PRIVATE_SEGMENT = /^(?:\.?(?:env(?:\..*)?|environment|env_vars|env_headers|headers|http_?headers|env_http_headers|auth(?:orization)?|cookies?|ssh|aws|gnupg|netrc|npmrc|git|kube|docker)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?)$/i;
const PRIVATE_NAME = /(?:\.(?:pem|key|pfx|p12|kdbx)$|(?:^|[._-])(?:sk[-_]|gh[pousr]_|github_pat_|AKIA)[a-z0-9]|[0-9a-f]{16,}|@[^@ ]+\.[^@ ]+)/i;

export function isSafeName(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 255 &&
    value !== '.' && value !== '..' && !Object.hasOwn(Object.prototype, value) &&
    /^[\p{L}\p{N}._@+ -]+$/u.test(value) && value.trim() === value;
}

export function isShareableName(value) {
  return isSafeName(value) && !SECRET_KEY.test(value) && !PRIVATE_SEGMENT.test(value) && !PRIVATE_NAME.test(value);
}

export function isSafeSourceId(id) {
  return id === 'setup' || (typeof id === 'string' && id.startsWith('extends:') && isShareableName(id.slice(8)));
}

export function addCount(counts, key, count = 1) {
  counts[key] = (counts[key] || 0) + count;
}

export function compareIds(a, b) {
  const left = JSON.stringify(a);
  const right = JSON.stringify(b);
  return left < right ? -1 : left > right ? 1 : 0;
}
