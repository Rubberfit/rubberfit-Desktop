# Third-party notices

The root MIT license covers RubberFit-authored code and does not replace third-party licenses. Existing source comments, copyright notices, and Git attribution must be retained.

## Sparrow-derived search code

Files under `crates/rf-layout/src/infrastructure/search/gls/` and `search/terminator.rs` identify code ported or adapted from [JeroenGar/sparrow](https://github.com/JeroenGar/sparrow/tree/ejor-snapshot), `ejor-snapshot` (identified in source as `c95454e3`).

Copyright (c) 2025 Jeroen Gardeyn, KU Leuven. The upstream MIT license is included verbatim in [licenses/sparrow-MIT.txt](licenses/sparrow-MIT.txt). File-level attribution remains in the source.

## jagua-rs and LBF

The Cargo workspace fetches jagua-rs and LBF from [JeroenGar/jagua-rs](https://github.com/JeroenGar/jagua-rs/tree/0.7.1), tag `0.7.1`. The upstream root license at that tag is MPL-2.0; its full text is included in [licenses/jagua-rs-MPL-2.0.txt](licenses/jagua-rs-MPL-2.0.txt). These dependencies retain their applicable upstream notices and terms.

## Other dependencies

JavaScript dependencies are declared in `package.json` and `package-lock.json`; Rust dependencies are declared in the Cargo manifests. Those packages retain their individual licenses. The UI also incorporates components and scaffolding from the React/Tauri/Radix/shadcn ecosystem. The root project license does not relicense those upstream works.

Application authors credited in `src-tauri/Cargo.toml` include Steven Fojas, Daniel Martinez Julio, and Alex Yamasaki. Original Git history is preserved.
