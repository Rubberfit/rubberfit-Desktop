# RubberFit Desktop

RubberFit Desktop is a desktop application for planning cuts from rubber rolls and other sheet material. It helps fabricators arrange parts, estimate waste, and identify reusable offcuts. This is a work in progress, with automatic nesting and an interactive manual layout editor.

The interface uses React, TypeScript, Vite, Tailwind CSS, Radix UI, and Konva. Tauri 2 connects it to the `rf-geom` and `rf-layout` Rust crates. The application began with Tauri/React scaffolding and includes application code shared with the RubberFit web project, alongside desktop integration and packing work. Original contributors remain credited in Git history and `src-tauri/Cargo.toml`.

Some services from the web application are currently stubs that throw `Not implemented on desktop`. They should not be treated as working cloud features. Use synthetic cut lists and demo data for development and shared examples.

## Setup

Install Node.js, npm, Git, and Rust via rustup. The workspace pins Rust **1.94** in `rust-toolchain.toml`. Install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform (on Windows, Microsoft C++ Build Tools and WebView2). Rust dependencies also require Git access to public upstream repositories.

```sh
git clone https://github.com/Rubberfit/rubberfit-Desktop.git
cd rubberfit-Desktop
npm ci
npm run tauri dev
```

The default development branch is `dev`. `npm run dev` starts only the browser frontend; native packing commands require the Tauri application. Build the desktop application with `npm run tauri build`; packaging prerequisites depend on the target operating system. Rust checks include `cargo test --workspace` and `cargo fmt --all --check`.

## Planned desktop work

The next development areas include at least 20 hours of work on desktop packing reliability and reproducibility, Rust geometry and offcut regression tests, local save/open workflows, and clearer UI behavior for incomplete services. These are plans, not completed features. This scope focuses on the native desktop workflow rather than the web application's CRM, employee, and invoicing features.

## License and attribution

RubberFit-authored code is available under the [MIT license](LICENSE). Third-party source and dependencies retain their own licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), including the preserved MIT notices for Sparrow-derived search code and MPL-2.0 licensing for jagua-rs.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## Main Features

AutoNest - This engine allows users to select preset shapes, create custom shapes and import shapes from csv files to be passed into Rust for nesting. Rust performs all complex math such as collision detection, packing and waste calculations, then all that data is passed back to Typescript to render the part placements, waste calculations and reusable offcuts. _Note: Typescript currently builds shapes, but that geometry math is being migrated to Rust._

Free Roam - Interactive packer where users can select shapes and custom pack them by dragging them around. Waste is calculated live while users move the shapes, giving users full control of where they'd like to pack objects to make cutting them easy.

## Tools

Typescript + React is used on the frontend for rendering and Free Roam's simulation. _Note: Free Roam will be migrated to Rust._

Rust + Jagua-rs + LBF_LNS is used for collision detection, packing and waste calculations. There are custom rust files that are used to perform waste/reusable offcut calculations and shape building.

## Development Instructions

Typechecking:

`npm run typecheck`

Linting:

`npm run lint`

`npm run lint:fix`

Formatting with Prettier:

`npm run format:check`

`npm run format`

Running the development environment:

`npm run tauri dev`
