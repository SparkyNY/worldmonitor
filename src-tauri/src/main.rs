#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use keyring::Entry;
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, RunEvent};

const LOCAL_API_PORT: &str = "46123";
const KEYRING_SERVICE: &str = "world-monitor";
const SUPPORTED_SECRET_KEYS: [&str; 13] = [
    "GROQ_API_KEY",
    "OPENROUTER_API_KEY",
    "FRED_API_KEY",
    "EIA_API_KEY",
    "CLOUDFLARE_API_TOKEN",
    "ACLED_ACCESS_TOKEN",
    "WINGBITS_API_KEY",
    "WS_RELAY_URL",
    "VITE_OPENSKY_RELAY_URL",
    "OPENSKY_CLIENT_ID",
    "OPENSKY_CLIENT_SECRET",
    "AISSTREAM_API_KEY",
    "VITE_WS_RELAY_URL",
];

#[derive(Default)]
struct LocalApiState {
    child: Mutex<Option<Child>>,
}

fn secret_entry(key: &str) -> Result<Entry, String> {
    if !SUPPORTED_SECRET_KEYS.contains(&key) {
        return Err(format!("Unsupported secret key: {key}"));
    }
    Entry::new(KEYRING_SERVICE, key).map_err(|e| format!("Keyring init failed: {e}"))
}

#[tauri::command]
fn list_supported_secret_keys() -> Vec<String> {
    SUPPORTED_SECRET_KEYS.iter().map(|key| (*key).to_string()).collect()
}

#[tauri::command]
fn get_secret(key: String) -> Result<Option<String>, String> {
    let entry = secret_entry(&key)?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(format!("Failed to read keyring secret: {err}")),
    }
}

#[tauri::command]
fn set_secret(key: String, value: String) -> Result<(), String> {
    let entry = secret_entry(&key)?;
    entry
        .set_password(&value)
        .map_err(|e| format!("Failed to write keyring secret: {e}"))
}

#[tauri::command]
fn delete_secret(key: String) -> Result<(), String> {
    let entry = secret_entry(&key)?;
    match entry.delete_credential() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(format!("Failed to delete keyring secret: {err}")),
    }
}

fn cache_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create app data directory {}: {e}", dir.display()))?;
    Ok(dir.join("persistent-cache.json"))
}

#[tauri::command]
fn read_cache_entry(app: AppHandle, key: String) -> Result<Option<Value>, String> {
    let path = cache_file_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }

    let contents = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read cache store {}: {e}", path.display()))?;
    let parsed: Value = serde_json::from_str(&contents).unwrap_or_else(|_| Value::Object(Map::new()));
    let Some(root) = parsed.as_object() else {
        return Ok(None);
    };

    Ok(root.get(&key).cloned())
}

#[tauri::command]
fn write_cache_entry(app: AppHandle, key: String, value: String) -> Result<(), String> {
    let path = cache_file_path(&app)?;

    let mut root: Map<String, Value> = if path.exists() {
        let contents = std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read cache store {}: {e}", path.display()))?;
        serde_json::from_str::<Value>(&contents)
            .ok()
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default()
    } else {
        Map::new()
    };

    let parsed_value: Value = serde_json::from_str(&value)
        .map_err(|e| format!("Invalid cache payload JSON: {e}"))?;
    root.insert(key, parsed_value);

    let serialized = serde_json::to_string_pretty(&Value::Object(root))
        .map_err(|e| format!("Failed to serialize cache store: {e}"))?;
    std::fs::write(&path, serialized)
        .map_err(|e| format!("Failed to write cache store {}: {e}", path.display()))
}

fn local_api_paths(app: &AppHandle) -> (PathBuf, PathBuf) {
    let resource_dir = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| PathBuf::from("."));

    let sidecar_script = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("sidecar/local-api-server.mjs")
    } else {
        resource_dir.join("sidecar/local-api-server.mjs")
    };

    let api_dir_root = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
    } else {
        resource_dir
    };

    (sidecar_script, api_dir_root)
}

fn start_local_api(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<LocalApiState>();
    let mut slot = state
        .child
        .lock()
        .map_err(|_| "Failed to lock local API state".to_string())?;
    if slot.is_some() {
        return Ok(());
    }

    let (script, resource_root) = local_api_paths(app);
    if !script.exists() {
        return Err(format!(
            "Local API sidecar script missing at {}",
            script.display()
        ));
    }

    let mut cmd = Command::new("node");
    cmd.arg(&script)
        .env("LOCAL_API_PORT", LOCAL_API_PORT)
        .env("LOCAL_API_RESOURCE_DIR", resource_root)
        .env("LOCAL_API_MODE", "tauri-sidecar")
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to launch local API: {e}"))?;
    *slot = Some(child);
    Ok(())
}

fn stop_local_api(app: &AppHandle) {
    if let Ok(state) = app.try_state::<LocalApiState>().ok_or(()) {
        if let Ok(mut slot) = state.child.lock() {
            if let Some(mut child) = slot.take() {
                let _ = child.kill();
            }
        }
    }
}

fn main() {
    tauri::Builder::default()
        .manage(LocalApiState::default())
        .invoke_handler(tauri::generate_handler![
            list_supported_secret_keys,
            get_secret,
            set_secret,
            delete_secret,
            read_cache_entry,
            write_cache_entry
        ])
        .setup(|app| {
            if let Err(err) = start_local_api(&app.handle()) {
                eprintln!("[tauri] local API sidecar failed to start: {err}");
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running world-monitor tauri application")
        .run(|app, event| {
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                stop_local_api(&app);
            }
        });
}
