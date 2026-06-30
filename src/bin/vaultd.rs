//! btech-vaultd — a long-lived, multi-vault service.
//!
//! Holds one finalized HTSS vault per id (each its own DKG / group key / address),
//! running each ceremony once and reusing it. The Next app calls it over HTTP and
//! passes `?id=<chatId>` so every channel/vault gets a distinct, stable address
//! you can deposit regtest funds into.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::{
    extract::{Query, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;

use btech::{DemoReport, HtssNoncePackage, SettlementReport, SettlementRequest, VaultKeyMaterial, WalletApp};

struct AppState {
    vaults: Mutex<HashMap<String, WalletApp>>,
    data_dir: PathBuf,
}

#[derive(Deserialize)]
struct VaultQuery {
    id: Option<String>,
}

#[derive(Deserialize)]
struct SignReq {
    recipient: String,
    #[serde(rename = "amountSats")]
    amount_sats: u64,
    nonce: String,
    memo: String,
}

#[derive(Deserialize)]
struct PrecommitReq {
    session: String,
    participant_id: u16,
}

#[derive(Deserialize)]
struct FinalizeReq {
    session: String,
    signer_set: Vec<u16>,
    recipient: String,
    #[serde(rename = "amountSats")]
    amount_sats: u64,
    nonce: String,
    memo: String,
}

fn err500(e: anyhow::Error) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

/// On-disk path for a vault's persisted key material.
fn vault_path(data_dir: &Path, id: &str) -> PathBuf {
    let safe: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    data_dir.join(format!("{safe}.json"))
}

/// Load a vault's persisted key material, or run DKG once and persist it. This
/// keeps each vault's group key — and therefore its receive addresses — stable
/// across restarts, so funds deposited to a vault stay spendable.
fn load_or_create_vault(data_dir: &Path, id: &str) -> anyhow::Result<WalletApp> {
    let path = vault_path(data_dir, id);
    if let Ok(bytes) = std::fs::read(&path) {
        match serde_json::from_slice::<VaultKeyMaterial>(&bytes) {
            Ok(material) => {
                eprintln!("btech-vaultd: loaded persisted vault '{id}'");
                return WalletApp::load(material);
            }
            Err(err) => eprintln!("btech-vaultd: ignoring corrupt vault file for '{id}': {err}"),
        }
    }
    let mut app = WalletApp::demo()?;
    app.init()?;
    if let Some(material) = app.export_vault() {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        match serde_json::to_vec_pretty(&material) {
            Ok(serialized) => match std::fs::write(&path, serialized) {
                Ok(()) => eprintln!("btech-vaultd: provisioned + persisted vault '{id}'"),
                Err(err) => eprintln!("btech-vaultd: failed to persist vault '{id}': {err}"),
            },
            Err(err) => eprintln!("btech-vaultd: failed to serialize vault '{id}': {err}"),
        }
    }
    Ok(app)
}

/// Get the vault for `id`, loading (or running DKG once + persisting) on first use.
fn with_vault<T>(
    state: &AppState,
    id: &str,
    f: impl FnOnce(&mut WalletApp) -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    let mut map = state.vaults.lock().expect("vault map lock");
    if !map.contains_key(id) {
        let app = load_or_create_vault(&state.data_dir, id)?;
        map.insert(id.to_string(), app);
    }
    f(map.get_mut(id).expect("vault present"))
}

async fn healthz() -> &'static str {
    "ok"
}

async fn vault_state(
    State(state): State<Arc<AppState>>,
    Query(q): Query<VaultQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let id = q.id.unwrap_or_else(|| "treasury".to_string());
    let value = with_vault(&state, &id, |app| app.vault_state()).map_err(err500)?;
    Ok(Json(value))
}

async fn vault_sign(
    State(state): State<Arc<AppState>>,
    Query(q): Query<VaultQuery>,
    Json(req): Json<SignReq>,
) -> Result<Json<DemoReport>, (StatusCode, String)> {
    let id = q.id.unwrap_or_else(|| "treasury".to_string());
    let report = with_vault(&state, &id, |app| {
        app.sign_payment(req.nonce, req.recipient, req.amount_sats, req.memo)
    })
    .map_err(err500)?;
    Ok(Json(report))
}

async fn vault_sign_precommit(
    State(state): State<Arc<AppState>>,
    Query(q): Query<VaultQuery>,
    Json(req): Json<PrecommitReq>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let id = q.id.unwrap_or_else(|| "treasury".to_string());
    let package: HtssNoncePackage = with_vault(&state, &id, |app| {
        app.htss_precommit(&req.session, req.participant_id)
    })
    .map_err(err500)?;
    let nonce_package = serde_json::to_value(&package).map_err(|e| err500(e.into()))?;
    Ok(Json(serde_json::json!({
        "participant_id": req.participant_id,
        "nonce_package": nonce_package,
    })))
}

async fn vault_sign_finalize(
    State(state): State<Arc<AppState>>,
    Query(q): Query<VaultQuery>,
    Json(req): Json<FinalizeReq>,
) -> Result<Json<DemoReport>, (StatusCode, String)> {
    let id = q.id.unwrap_or_else(|| "treasury".to_string());
    let report = with_vault(&state, &id, |app| {
        app.htss_finalize(
            &req.session,
            &req.nonce,
            &req.recipient,
            req.amount_sats,
            &req.memo,
            req.signer_set.clone(),
        )
    })
    .map_err(err500)?;
    Ok(Json(report))
}

/// Build, sign, and return a broadcastable Taproot key-path spend out of the
/// vault. The caller broadcasts the returned raw transaction.
async fn vault_settle(
    State(state): State<Arc<AppState>>,
    Query(q): Query<VaultQuery>,
    Json(req): Json<SettlementRequest>,
) -> Result<Json<SettlementReport>, (StatusCode, String)> {
    let id = q.id.unwrap_or_else(|| "treasury".to_string());
    let report = with_vault(&state, &id, |app| app.settle_taproot_spend(req)).map_err(err500)?;
    Ok(Json(report))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let data_dir = PathBuf::from(
        std::env::var("BTECH_VAULTD_DATA").unwrap_or_else(|_| "data/vaultd".to_string()),
    );
    std::fs::create_dir_all(&data_dir).ok();
    let state = Arc::new(AppState {
        vaults: Mutex::new(HashMap::new()),
        data_dir,
    });
    // Warm the default treasury vault so the first page load is instant.
    with_vault(&state, "treasury", |_| Ok(()))?;

    let router = Router::new()
        .route("/healthz", get(healthz))
        .route("/vault/state", get(vault_state))
        .route("/vault/sign", post(vault_sign))
        .route("/vault/sign/precommit", post(vault_sign_precommit))
        .route("/vault/sign/finalize", post(vault_sign_finalize))
        .route("/vault/settle", post(vault_settle))
        .with_state(state);

    let port = std::env::var("BTECH_VAULTD_PORT").unwrap_or_else(|_| "8787".to_string());
    let addr = format!("127.0.0.1:{port}");
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    eprintln!("btech-vaultd listening on http://{addr}");
    axum::serve(listener, router).await?;
    Ok(())
}
