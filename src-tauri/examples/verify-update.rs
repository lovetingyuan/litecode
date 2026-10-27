use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use std::{error::Error, fs};

fn verify(args: &[String]) -> Result<(), Box<dyn Error>> {
    if args.len() != 5 {
        return Err("Usage: verify-update INSTALLER SIGNATURE TAURI_CONFIG VERSION".into());
    }
    let config: serde_json::Value = serde_json::from_slice(&fs::read(&args[3])?)?;
    let public = config["plugins"]["updater"]["pubkey"]
        .as_str()
        .ok_or("Missing updater public key")?;
    let decode = |s: &str| -> Result<String, Box<dyn Error>> {
        Ok(String::from_utf8(
            base64::engine::general_purpose::STANDARD.decode(s.trim())?,
        )?)
    };
    let public = PublicKey::decode(&decode(public)?)?;
    let signature = Signature::decode(&decode(&fs::read_to_string(&args[2])?)?)?;
    public.verify(&fs::read(&args[1])?, &signature, true)?;
    if !signature
        .trusted_comment()
        .split('\t')
        .any(|field| field == format!("version:{}", args[4]))
    {
        return Err("Signature does not bind the expected application version".into());
    }
    Ok(())
}

fn main() {
    if let Err(error) = verify(&std::env::args().collect::<Vec<_>>()) {
        eprintln!("Update signature verification failed: {error}");
        std::process::exit(1);
    }
}
