//! btech-vaultd — a long-lived, multi-vault service.
//!
//! Holds one finalized HTSS vault per id (each its own DKG / group key / address),
//! running each ceremony once and reusing it. The Next app calls it over HTTP and
//! passes `?id=<chatId>` so every channel/vault gets a distinct, stable address
//! you can deposit regtest funds into.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::{
    extract::{Query, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;

use btech::{DemoReport, WalletApp};

struct AppState {
    vaults: Mutex<HashMap<String, WalletApp>>,
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

fn err500(e: anyhow::Error) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

/// Get the vault for `id`, creating + running its DKG once on first use.
fn with_vault<T>(
    state: &AppState,
    id: &str,
    f: impl FnOnce(&mut WalletApp) -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    let mut map = state.vaults.lock().expect("vault map lock");
    if !map.contains_key(id) {
        let mut app = WalletApp::demo()?;
        app.init()?;
        eprintln!("btech-vaultd: provisioned vault '{id}'");
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

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let state = Arc::new(AppState {
        vaults: Mutex::new(HashMap::new()),
    });
    // Warm the default treasury vault so the first page load is instant.
    with_vault(&state, "treasury", |_| Ok(()))?;

    let router = Router::new()
        .route("/healthz", get(healthz))
        .route("/vault/state", get(vault_state))
        .route("/vault/sign", post(vault_sign))
        .with_state(state);

    let port = std::env::var("BTECH_VAULTD_PORT").unwrap_or_else(|_| "8787".to_string());
    let addr = format!("127.0.0.1:{port}");
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    eprintln!("btech-vaultd listening on http://{addr}");
    axum::serve(listener, router).await?;
    Ok(())
}
