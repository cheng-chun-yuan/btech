//! btech-vaultd — a long-lived vault service.
//!
//! Runs the HTSS DKG once at startup and keeps the finalized vault in memory, so
//! signing reuses the same key (run once, sign many) instead of regenerating the
//! vault on every request. The Next app calls it over HTTP.

use std::sync::{Arc, Mutex};

use axum::{
    extract::State,
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;

use btech::WalletApp;

struct AppState {
    app: Mutex<WalletApp>,
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

async fn healthz() -> &'static str {
    "ok"
}

async fn vault_state(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let value = {
        let mut app = state.app.lock().expect("vault lock");
        app.vault_state().map_err(err500)?
    };
    Ok(Json(value))
}

async fn vault_sign(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SignReq>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let report = {
        let mut app = state.app.lock().expect("vault lock");
        app.sign_payment(req.nonce, req.recipient, req.amount_sats, req.memo)
            .map_err(err500)?
    };
    Ok(Json(serde_json::to_value(report).map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
    })?))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut app = WalletApp::demo()?;
    app.init()?; // run DKG once up front
    eprintln!("btech-vaultd: vault DKG finalized");

    let state = Arc::new(AppState {
        app: Mutex::new(app),
    });

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
