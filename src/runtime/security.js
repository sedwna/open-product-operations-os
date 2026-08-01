const CREDENTIAL_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret|authorization)\s*["']?\s*[:=]\s*["']?[^\s"']{8,}/i,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/
];

export function assertNoCredentialMaterial(label, value) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(serialized))) {
    throw new Error(`${label} appears to contain credential material.`);
  }
}
