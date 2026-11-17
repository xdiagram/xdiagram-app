//! The server reports the app's version (tauri.conf.json), which releases bump, so the two can
//! never disagree.

fn main() {
    let conf = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tauri.conf.json");
    println!("cargo:rerun-if-changed={}", conf.display());
    let version = std::fs::read_to_string(&conf)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|json| json.get("version").and_then(|v| v.as_str()).map(str::to_string))
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
    println!("cargo:rustc-env=XDIAGRAM_VERSION={version}");
}
