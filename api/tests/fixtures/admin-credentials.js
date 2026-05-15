// Seed réutilisable pour device_admin_credentials (table LAPS).
// Le ciphertext est un dummy — les tests qui exercent le GET doivent
// fournir un ciphertext chiffré avec la clé RSA de test (cf. encryptForTest).

export async function insertAdminCredential(db, {
  device_id,
  username = 'opale-recovery',
  encrypted_password = Buffer.from('fake-ciphertext'),
  rotation_requested_at = null,
} = {}) {
  const { rows } = await db.query(`
    INSERT INTO device_admin_credentials
      (device_id, username, encrypted_password, password_changed_at, rotation_requested_at)
    VALUES ($1, $2, $3, now(), $4)
    ON CONFLICT (device_id) DO UPDATE SET
      encrypted_password = EXCLUDED.encrypted_password,
      rotation_requested_at = EXCLUDED.rotation_requested_at
    RETURNING *
  `, [device_id, username, encrypted_password, rotation_requested_at])
  return rows[0]
}
