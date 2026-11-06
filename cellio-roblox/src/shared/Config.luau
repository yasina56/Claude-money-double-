-- Game constants. Simulation units match the web version (1 unit = 1 "pixel");
-- the client renders at Config.STUDS_PER_UNIT so all balance numbers stay identical.
local Config = {}

Config.STUDS_PER_UNIT = 0.1
Config.WORLD_SIZE = 4800
Config.TICK_RATE = 30 -- simulation steps per second
Config.SNAPSHOT_EVERY = 2 -- snapshot every N ticks (15 Hz)
Config.NUTRIENT_EVERY = 4 -- nutrient deltas every N ticks

Config.NUTRIENT_TARGET = 1600
Config.CRYSTAL_TARGET = 24
Config.NUTRIENT_RADIUS = 6
Config.CRYSTAL_RADIUS = 9
Config.CRYSTAL_XP = 8

Config.START_BIOMASS = 10
Config.MAX_BIOMASS = 2600
Config.BIOMASS_DECAY_START = 350
Config.BIOMASS_DECAY_RATE = 0.0025

Config.SPAWN_PROTECTION = 5
Config.EVOLVE_PROTECTION = 8
Config.EVOLVE_COMBAT_LOCK = 1.5
Config.EVOLVE_SLOW = 0.45
Config.COMBAT_TIMEOUT = 4
Config.KILL_CREDIT_WINDOW = 10
Config.MAX_HIT_FRACTION = 0.3
Config.PAIR_HIT_COOLDOWN = 0.35

Config.DASH_COST = 28
Config.DASH_COOLDOWN = 2.6
Config.DASH_IMPULSE = 380

Config.APEX_LEVEL = 20
Config.MAX_LEVEL = 30

function Config.radiusFromBiomass(biomass: number): number
	return 14 + math.sqrt(math.max(0, biomass)) * 2.6
end

-- Camera height (studs) for a cell radius (units): bigger cells see more.
function Config.cameraHeight(radius: number): number
	return math.clamp(55 * (radius / 22) ^ 0.5, 50, 220)
end

-- Half-size of the area of interest (units) around a player for snapshots.
function Config.viewHalfExtent(radius: number): number
	-- FOV 70: half-height ~0.7 * height; widescreen ~1.8x wider.
	return Config.cameraHeight(radius) / Config.STUDS_PER_UNIT * 1.3 + 250
end

return Config
