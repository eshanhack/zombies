# Stahlbunker 1945 — Art Direction

Stahlbunker is an original fictional bunker. Its architecture, props, markings, characters,
weapons, and graphic design are authored for this project. No imagery, models, textures,
audio, layouts, or names from another game are used.

## Visual language

- **Start Hall:** battered plaster over coarse aggregate, timber repairs, soot, cold exterior
  moonlight interrupted by one unreliable tungsten circuit.
- **Armory:** oxidized steel storage, painted identification bands, drier concrete, dense
  conduit and improvised weapon chalk.
- **Generator:** damp poured concrete, oil-dark floor, large cable runs, steam piping, blue
  industrial fill and the warm power-up surge.
- **Catwalk:** exposed structure, riveted steel, scorched Forge surround, long sightlines into
  the Generator room.
- **Exterior:** implied trenches, dead trees, wire and fog silhouettes. It is never a navigable
  reproduction of a historical site.

The rendering target is a restrained late-2000s military-horror image: strong silhouettes,
localized specular response, cool ambient light against isolated warm practicals, restrained
bloom, visible grain, and texture detail that does not overwhelm gameplay readability.

## Legal reference board

The following references inform material wear, construction logic, and period infrastructure
only. They are not shipped in the game and are not traced or reproduced.

- [German occupation bunker concrete wood grain](https://commons.wikimedia.org/wiki/File:Wood_grain_German_Occupation_bunker_concrete_3.jpg) — Wikimedia Commons, public domain.
- [Guernsey World War II bunker](https://commons.wikimedia.org/wiki/File:Guernsey_July_2011_198,_World_War_II_bunker.jpg) — Wikimedia Commons, public domain.
- [Rijksbergplaats Paasloo interior (1942)](https://commons.wikimedia.org/wiki/File:Het_interieur_van_de_Rijksbergplaats_te_Paasloo,_RMA-SSA-F-05427-1.jpg) — Wikimedia Commons, CC0.
- [Tirpitz bunker interior](https://commons.wikimedia.org/wiki/File:Tirpitz_Bunker_interior_01.jpg) — Wikimedia Commons, CC0.
- [Midway Atoll underground bunker documentation](https://commons.wikimedia.org/wiki/File:Figure_44-_Underground_Bunker_(Property_No._E-2),_Midway_Atoll,_Eastern_Island_(April_16,_2015)_(26070495696).jpg) — United States government work, public domain.
- [Imperial War Museums: Cabinet War Rooms history](https://www.iwm.org.uk/history/a-short-history-of-the-cabinet-war-rooms) — historical infrastructure reference; not redistributed.

## Procedural material pipeline

`npm run assets:generate` deterministically authors five 2048×2048 RGBA atlases under
`public/assets/materials`. Each contains concrete, plaster, timber, and steel quadrants with
co-registered albedo, tangent-space normal, roughness, ambient-occlusion, and emissive data.
The build regenerates the exact same bytes and the runtime crops quadrants into repeatable
channels. These files are original project output and require no third-party attribution.
