use std::env;
use std::fs;
use std::path::PathBuf;

/// Reads engines.node from the root package.json without extra build
/// dependencies, so the desktop boot error states the same Node.js
/// requirement as the npm package.
fn node_engine(package_json: &str) -> Option<String> {
    let engines = &package_json[package_json.find("\"engines\"")?..];
    let block = &engines[..engines.find('}')?];
    let after_key = &block[block.find("\"node\"")? + "\"node\"".len()..];
    let value = after_key[after_key.find(':')? + 1..]
        .trim_start()
        .strip_prefix('"')?;
    Some(value[..value.find('"')?].to_string())
}

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let package_json = manifest_dir.join("..").join("..").join("package.json");
    println!("cargo:rerun-if-changed={}", package_json.display());
    let engine = fs::read_to_string(&package_json)
        .ok()
        .and_then(|text| node_engine(&text))
        .unwrap_or_else(|| {
            println!(
                "cargo:warning=engines.node not found in the root package.json; using >=22.13.0"
            );
            ">=22.13.0".to_string()
        });
    println!("cargo:rustc-env=META_KIM_NODE_ENGINE={}", engine);
    tauri_build::build()
}
