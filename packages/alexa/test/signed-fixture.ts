import { generateKeyPairSync, sign } from 'node:crypto';
import forge from 'node-forge';

// Ephemeral synthetic keys only: no private material is stored in the repository.
export function signedFixture(now: number, san = 'echo-api.amazon.com', sanType = 2) {
  const rootKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const leafKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = (pair: typeof rootKeys) =>
    forge.pki.privateKeyFromPem(pair.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString());
  const publicKey = (pair: typeof rootKeys) =>
    forge.pki.publicKeyFromPem(pair.publicKey.export({ type: 'spki', format: 'pem' }).toString());
  const root = forge.pki.createCertificate();
  root.publicKey = publicKey(rootKeys);
  root.serialNumber = '01';
  root.validity.notBefore = new Date(now - 60_000);
  root.validity.notAfter = new Date(now + 600_000);
  root.setSubject([{ name: 'commonName', value: 'Synthetic Alexa Test CA' }]);
  root.setIssuer(root.subject.attributes);
  root.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true },
  ]);
  root.sign(key(rootKeys), forge.md.sha256.create());
  const leaf = forge.pki.createCertificate();
  leaf.publicKey = publicKey(leafKeys);
  leaf.serialNumber = '02';
  leaf.validity.notBefore = new Date(now - 60_000);
  leaf.validity.notAfter = new Date(now + 120_000);
  leaf.setSubject([{ name: 'commonName', value: san }]);
  leaf.setIssuer(root.subject.attributes);
  leaf.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true },
    { name: 'subjectAltName', altNames: [{ type: sanType, value: san }] },
  ]);
  leaf.sign(key(rootKeys), forge.md.sha256.create());
  const trustRoots = [forge.pki.certificateToPem(root)];
  const pem = forge.pki.certificateToPem(leaf) + trustRoots[0];
  const event = {
    version: '1.0',
    context: { System: { application: { applicationId: 'test-skill' }, user: { userId: 'test-user' } } },
    request: {
      type: 'IntentRequest',
      requestId: 'request-one',
      timestamp: new Date(now).toISOString(),
      locale: 'en-US',
      intent: {
        name: 'RememberIntent',
        slots: { Text: { name: 'Text', value: 'The spare key is in the blue drawer' } },
      },
    },
  };
  const signed = (value: unknown = event, algorithm = 'RSA-SHA256') => {
    const payload = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    return {
      payload,
      headers: {
        'content-type': 'application/json',
        signaturecertchainurl: 'https://s3.amazonaws.com/echo.api/synthetic-test-certificate.pem',
        'signature-256': sign(algorithm, payload, leafKeys.privateKey).toString('base64'),
      },
    };
  };
  return { pem, trustRoots, event, signed };
}
