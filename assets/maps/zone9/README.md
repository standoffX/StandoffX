# Zone 9 map assets

The gameplay client loads the optimized FBX bundle from these exact paths:

- `assets/maps/zone9/Zone9.fbx`
- `assets/maps/zone9/textures/*.webp`

The source FBX and its 15 optimized WebP textures are packaged in the separately supplied `Zone9_Optimized_Assets.zip`. Extract the archive at the repository root and merge its `assets/` directory into the existing repository before expecting the full mesh and materials to load. Until then the client falls back to a lightweight procedural industrial preview.

The map importer normalizes the horizontal span to 250 units, disables mesh shadows, enables frustum culling and texture mipmaps, limits anisotropy, and reduces render resolution on Zone 9. CT spawn is currently provisional at `(-92, 0, 92)` in normalized map coordinates; verify the exact position against the FBX orientation in-game.

Zone 9 is enabled only in tester training, not public matchmaking. Keep the FBX and WebP filenames (including spaces and capitalization) unchanged.
