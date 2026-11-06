-- Organelle catalogue and per-level tuning. Same numbers as the web version
-- (cell-io/shared/organelles.ts); per-level arrays are indexed by level (1..3).
local Organelles = {}

local rad = math.rad

Organelles.TYPES = { "cilia", "spikes", "stinger", "membrane", "mitochondria", "venom", "regen", "flagellum", "toxin" }

Organelles.DEFS = {
	cilia = {
		name = "Cilia", role = "Movement", mount = "surface", span = 1, slotCost = 1, weight = 0.01, upkeep = 0.25, unlockLevel = 2,
		color = Color3.fromRGB(184, 247, 255),
		levelNames = { "Cilia", "Beating Cilia", "Power Cilia" },
		levelText = { "+9% movement effectiveness", "+17% movement effectiveness", "+28% movement effectiveness" },
		placement = "Pushes the cell away from the side it sits on. Rear = speed, sides = turning, a ring = agility.",
	},
	spikes = {
		name = "Spikes", role = "Physical damage", mount = "surface", span = 1, slotCost = 1, weight = 0.02, upkeep = 0, unlockLevel = 2,
		color = Color3.fromRGB(255, 241, 214),
		levelNames = { "Short Spikes", "Reinforced Spikes", "Barbed Spikes" },
		levelText = { "Contact damage where it points, scales with impact speed", "+52% spike damage", "+109% spike damage, hits cause bleeding" },
		placement = "Only hits inside the spike's arc count. Front spikes ram; rear spikes punish chasers.",
	},
	stinger = {
		name = "Stinger", role = "Venom delivery", mount = "surface", span = 1, slotCost = 1, weight = 0.01, upkeep = 0, unlockLevel = 4,
		color = Color3.fromRGB(226, 182, 255),
		levelNames = { "Stinger", "Hollow Stinger", "Injector" },
		levelText = { "Small damage; delivers venom at full potency", "+30% damage, wider arc", "+60% damage, wider arc" },
		placement = "Links to a venom sac on the same side (or a centered sac at 60%).",
	},
	membrane = {
		name = "Reinforced Membrane", role = "Defense", mount = "surface", span = 3, slotCost = 2, weight = 0.06, upkeep = 0, unlockLevel = 2,
		color = Color3.fromRGB(127, 166, 217),
		levelNames = { "Plated Membrane", "Layered Membrane", "Chitin Shell" },
		levelText = { "-34% damage from the covered side", "-47% damage from the covered side", "-56% damage from the covered side" },
		placement = "Covers a ~72 degree arc. Only that side is protected. Heavy.",
	},
	mitochondria = {
		name = "Mitochondria", role = "Energy", mount = "internal", span = 1, slotCost = 1, weight = 0.01, upkeep = 0, unlockLevel = 2,
		color = Color3.fromRGB(255, 157, 77),
		levelNames = { "Mitochondria", "Dense Mitochondria", "Hyper Mitochondria" },
		levelText = { "+3 energy/s, +10 max energy", "+5 energy/s, +15 max energy", "+7.5 energy/s, +22 max energy" },
		placement = "Internal. In the center it also boosts regeneration by 15%.",
	},
	venom = {
		name = "Venom Sac", role = "Poison", mount = "internal", span = 1, slotCost = 2, weight = 0.02, upkeep = 0.2, unlockLevel = 4,
		color = Color3.fromRGB(176, 77, 255),
		levelNames = { "Venom Sac", "Paralytic Venom", "Necrotic Venom" },
		levelText = { "Linked hits poison: 2.8 dmg/s per stack (max 3). [R] Venom surge", "4.2 dmg/s per stack, slows 15%", "5.6 dmg/s per stack, slows 25%" },
		placement = "Needs a stinger or spike within 70 degrees of its side. No delivery, no poison.",
	},
	regen = {
		name = "Regeneration Nucleus", role = "Healing", mount = "internal", span = 1, slotCost = 2, weight = 0.03, upkeep = 0, unlockLevel = 4,
		color = Color3.fromRGB(93, 255, 154),
		levelNames = { "Regen Nucleus", "Vital Nucleus", "Phoenix Nucleus" },
		levelText = { "Heals 0.5% max HP/s, x3 out of combat", "Heals 0.75% max HP/s, x3 out of combat", "Heals 1.1% max HP/s, x3 out of combat" },
		placement = "Internal. In the center slot it heals 25% more.",
	},
	flagellum = {
		name = "Flagellum", role = "Directional speed", mount = "surface", span = 1, slotCost = 2, weight = 0.02, upkeep = 0.5, unlockLevel = 7,
		color = Color3.fromRGB(255, 224, 102),
		levelNames = { "Flagellum", "Whip Flagellum", "Turbo Flagellum" },
		levelText = { "+35% thrust opposite its mount, -16% turning", "+45% thrust, -13% turning", "+55% thrust, -10% turning" },
		placement = "Thrusts away from where it is attached. Rear = raw speed. Your dash follows it.",
	},
	toxin = {
		name = "Toxin Gland", role = "Area defense", mount = "internal", span = 1, slotCost = 2, weight = 0.03, upkeep = 0, unlockLevel = 7,
		color = Color3.fromRGB(198, 255, 61),
		levelNames = { "Toxin Gland", "Caustic Gland", "Miasma Gland" },
		levelText = { "[Q] Toxic cloud: 10 dmg/s for 6 s, slows 20%, shoves enemies out", "[Q] 13.5 dmg/s, larger cloud", "[Q] 17 dmg/s, larger cloud" },
		placement = "Centered: the cloud surrounds you. Edge: it is projected on that side.",
	},
}

Organelles.TUNING = {
	ciliaEff = { 0.09, 0.17, 0.28 },
	spikeDmg = { 11.5, 17.5, 24 },
	spikeArc = rad(22),
	spikeLength = { 0.35, 0.45, 0.55 },
	stingerDmg = { 5, 6.5, 8 },
	stingerArc = { rad(15), rad(19), rad(23) },
	membraneReduction = { 0.34, 0.47, 0.56 },
	membraneHalfArc = rad(36),
	mitoRegen = { 3, 5, 7.5 },
	mitoEnergy = { 10, 15, 22 },
	venomDps = { 2.8, 4.2, 5.6 },
	venomSlow = { 0, 0.15, 0.25 },
	venomDuration = 4,
	venomMaxStacks = 3,
	venomCost = 5,
	venomLinkArc = rad(70),
	venomSurgeCost = 25,
	venomSurgeCooldown = 10,
	venomSurgeDuration = 3,
	regenFrac = { 0.005, 0.0075, 0.011 },
	regenEnergyPerSec = 1.4,
	flagThrust = { 0.35, 0.45, 0.55 },
	flagTurnPenalty = { 0.16, 0.13, 0.1 },
	toxinDps = { 10, 13.5, 17 },
	toxinSlow = 0.2,
	toxinKnockback = 380,
	toxinCenterReach = 0.4,
	bumpFactor = 0.03,
	toxinRadius = { 80, 100, 120 },
	toxinCost = 35,
	toxinCooldown = 13,
	toxinDuration = 6,
}

-- Organelle integrity (spikes, stingers, membranes can break and regrow).
Organelles.INTEGRITY = {
	spikes = { 34, 48, 66 },
	stinger = { 24, 32, 42 },
	membrane = { 60, 84, 112 },
}
Organelles.REGROW_TIME = 12
Organelles.INTEGRITY_HEAL = 0.04
Organelles.SOAK = { membrane = 0.8, weapon = 0.45, chipOnArmor = 0.3 }

return Organelles
