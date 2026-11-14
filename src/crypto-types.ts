export type EncryptionDevice = { id: string; userId: string; name: string; label: string; publicKey: string; fingerprint: string; createdAt: number; current?: boolean; identity: string };
export type EncryptedEnvelope = { v: 1; deviceId: string; clientId: string; roster: string; ciphertext: string };
export type EncryptionState = { enabled: boolean; roster: string; devices: EncryptionDevice[] };
