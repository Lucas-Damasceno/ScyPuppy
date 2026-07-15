use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub(crate) const CONTEXT_FILE_MAGIC: &[u8] = b"CLIPSCRY-CONTEXT-1\0";
const CONTEXT_FILE_AAD: &[u8] = b"Scryppy encrypted context v1";

pub(crate) fn encrypt_context_file(markdown: &str, hex_key: &str) -> Result<Vec<u8>, String> {
    let key = hex_key_to_bytes(hex_key)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|error| error.to_string())?;
    let uuid = Uuid::new_v4();
    let nonce = Nonce::from_slice(&uuid.as_bytes()[..12]);
    let ciphertext = cipher
        .encrypt(
            nonce,
            Payload {
                msg: markdown.as_bytes(),
                aad: CONTEXT_FILE_AAD,
            },
        )
        .map_err(|error| error.to_string())?;
    let mut output = Vec::with_capacity(CONTEXT_FILE_MAGIC.len() + 12 + ciphertext.len());
    output.extend_from_slice(CONTEXT_FILE_MAGIC);
    output.extend_from_slice(nonce.as_slice());
    output.extend_from_slice(&ciphertext);
    Ok(output)
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn hex_key_to_bytes(value: &str) -> Result<[u8; 32], String> {
    if value.len() != 64 || !value.chars().all(|character| character.is_ascii_hexdigit()) {
        return Err("Chave de contexto inválida.".into());
    }
    let mut bytes = [0u8; 32];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
            .map_err(|error| error.to_string())?;
    }
    Ok(bytes)
}
