use std::{env, fs, path::PathBuf};

fn main() {
    if env::var_os("CARGO_FEATURE_SYNTHETIC_PROFILE").is_some()
        && env::var("PROFILE").as_deref() == Ok("release")
    {
        panic!("synthetic-profile is test-only and cannot produce a release artifact");
    }
    println!("cargo:rerun-if-changed=src/interpose.c");
    println!("cargo:rerun-if-changed=src/hide.S");
    cc::Build::new()
        .file("src/interpose.c")
        .file("src/hide.S")
        .flag("-fvisibility=hidden")
        .compile("ppapi_host_interpose");

    let version_script =
        PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR")).join("ppapi-host.map");
    fs::write(
        &version_script,
        "GLIBC_2.2.5 { global: dlopen; local: *; };\n",
    )
    .expect("write version script");
    println!(
        "cargo:rustc-cdylib-link-arg=-Wl,--version-script={}",
        version_script.display()
    );
    println!("cargo:rustc-cdylib-link-arg=-Wl,-z,now,-z,relro,-z,nodelete");
}
