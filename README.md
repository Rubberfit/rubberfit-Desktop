# Tauri + React + Typescript

This template should help get you started developing with Tauri, React and Typescript in Vite.

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
