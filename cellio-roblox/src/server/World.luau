-- Authoritative simulation for one arena. Port of cell-io/shared/sim/world.ts.
-- No networking here: the server entry script drives it and serializes state.
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("Shared")
local Config = require(Shared.Config)
local MathUtil = require(Shared.MathUtil)
local Organelles = require(Shared.Organelles)
local Placement = require(Shared.Placement)
local Progression = require(Shared.Progression)
local Stats = require(Shared.Stats)
local Movement = require(Shared.Movement)

local T = Organelles.TUNING
local angleDiff = MathUtil.angleDiff
local clamp = MathUtil.clamp
local TAU = MathUtil.TAU

local World = {}
World.__index = World

local GRID = 120 -- nutrient grid cell size (units)

function World.new()
	local self = setmetatable({}, World)
	self.size = Config.WORLD_SIZE
	self.time = 0
	self.nextId = 1
	self.cells = {} -- id -> cell
	self.nutrients = {} -- id -> nutrient
	self.grid = {} -- key -> { [id] = nutrient }
	self.crystalCount = 0
	self.nutrientCount = 0
	self.clouds = {}
	self.hazards = {}
	self.events = {}
	self.blooms = {}
	self.aiDifficulty = 0.2
	self.rng = Random.new()
	self.onDeath = function(_cell, _stats) end
	self:createHazards()
	for _ = 1, 36 do
		table.insert(self.blooms, { x = self.rng:NextNumber() * self.size, y = self.rng:NextNumber() * self.size })
	end
	for _ = 1, Config.NUTRIENT_TARGET do
		self:spawnNutrient(false)
	end
	for _ = 1, Config.CRYSTAL_TARGET do
		self:spawnNutrient(true)
	end
	return self
end

function World:id(): number
	local id = self.nextId
	self.nextId += 1
	return id
end

function World:rand(): number
	return self.rng:NextNumber()
end

-- ------------------------------------------------------------ setup

function World:createHazards()
	for _ = 1, 7 do
		table.insert(self.hazards, { kind = "acid", x = 400 + self:rand() * (self.size - 800), y = 400 + self:rand() * (self.size - 800), r = 110 + self:rand() * 110 })
	end
	for _ = 1, 5 do
		table.insert(self.hazards, {
			kind = "current",
			x = 400 + self:rand() * (self.size - 800),
			y = 400 + self:rand() * (self.size - 800),
			r = 260 + self:rand() * 200,
			dir = self:rand() * TAU,
			strength = 70 + self:rand() * 50,
		})
	end
end

local function gridKey(x: number, y: number): number
	return math.floor(x / GRID) * 1000 + math.floor(y / GRID)
end

function World:queryNutrients(x0: number, y0: number, x1: number, y1: number, fn)
	for gx = math.floor(math.max(0, x0) / GRID), math.floor(math.min(self.size, x1) / GRID) do
		for gy = math.floor(math.max(0, y0) / GRID), math.floor(math.min(self.size, y1) / GRID) do
			local bucket = self.grid[gx * 1000 + gy]
			if bucket then
				for _, n in bucket do
					fn(n)
				end
			end
		end
	end
end

function World:spawnNutrient(crystal: boolean, at, spread: number?)
	local x, y
	if at then
		local a = self:rand() * TAU
		local d = math.sqrt(self:rand()) * (spread or 0)
		x, y = at.x + math.cos(a) * d, at.y + math.sin(a) * d
	elseif crystal and self:rand() < 0.65 then
		-- Rare resources sit on the rims of acid pools.
		local acids = {}
		for _, h in self.hazards do
			if h.kind == "acid" then
				table.insert(acids, h)
			end
		end
		local h = acids[self.rng:NextInteger(1, #acids)]
		local a = self:rand() * TAU
		local d = h.r * (0.5 + self:rand() * 0.8)
		x, y = h.x + math.cos(a) * d, h.y + math.sin(a) * d
	elseif not crystal and self:rand() < 0.45 then
		local b = self.blooms[self.rng:NextInteger(1, #self.blooms)]
		local a = self:rand() * TAU
		local d = math.sqrt(self:rand()) * 220
		x, y = b.x + math.cos(a) * d, b.y + math.sin(a) * d
	else
		x, y = self:rand() * self.size, self:rand() * self.size
	end
	x = clamp(x, 20, self.size - 20)
	y = clamp(y, 20, self.size - 20)
	local n = if crystal
		then { id = self:id(), x = x, y = y, kind = 5, value = 2, xp = Config.CRYSTAL_XP }
		else { id = self:id(), x = x, y = y, kind = self.rng:NextInteger(0, 4), value = 1, xp = 1 }
	if crystal then
		self.crystalCount += 1
	else
		self.nutrientCount += 1
	end
	self.nutrients[n.id] = n
	local key = gridKey(x, y)
	local bucket = self.grid[key]
	if not bucket then
		bucket = {}
		self.grid[key] = bucket
	end
	bucket[n.id] = n
	return n
end

function World:removeNutrient(n)
	self.nutrients[n.id] = nil
	local bucket = self.grid[gridKey(n.x, n.y)]
	if bucket then
		bucket[n.id] = nil
	end
	if n.kind == 5 then
		self.crystalCount -= 1
	else
		self.nutrientCount -= 1
	end
end

-- Spawn far from bigger armed cells and away from acid.
function World:findSpawnPoint(radius: number)
	local best, bestScore = { x = self.size / 2, y = self.size / 2 }, -math.huge
	for _ = 1, 24 do
		local p = { x = 150 + self:rand() * (self.size - 300), y = 150 + self:rand() * (self.size - 300) }
		local score = 1e6
		for _, c in self.cells do
			if c.stats.radius >= radius * 1.05 or #c.stats.deliveries > 0 then
				score = math.min(score, math.sqrt((c.x - p.x) ^ 2 + (c.y - p.y) ^ 2) - c.stats.radius)
			end
		end
		for _, h in self.hazards do
			if h.kind == "acid" and math.sqrt((h.x - p.x) ^ 2 + (h.y - p.y) ^ 2) < h.r + 80 then
				score -= 2000
			end
		end
		if score > bestScore then
			best, bestScore = p, score
		end
	end
	return best
end

-- ------------------------------------------------------------ cells

function World:refreshStats(c)
	-- Keep integrity aligned with the layout; growth scales max integrity.
	local radius = Config.radiusFromBiomass(c.biomass)
	for i, o in c.organelles do
		local base = Organelles.INTEGRITY[o.type]
		local max = if base then base[math.clamp(o.level, 1, 3)] * math.sqrt(radius / 22) else 0
		local h = c.orgHealth[i]
		if not h then
			c.orgHealth[i] = { hp = max, max = max, regrow = 0 }
		elseif h.max ~= max then
			h.hp = if h.max > 0 then h.hp / h.max * max else max
			h.max = max
		end
	end
	local disabled = {}
	for i, h in c.orgHealth do
		disabled[i] = h.regrow > 0
	end
	local oldMax = if c.stats then c.stats.maxHp else 0
	c.stats = Stats.compute(c.biomass, c.level, c.organelles, c.mutations, disabled)
	local delta = c.stats.maxHp - oldMax
	if c.hp and delta > 0 then
		c.hp += delta
	end
	c.hp = math.min(c.hp or c.stats.maxHp, c.stats.maxHp)
	c.energy = math.min(c.energy or c.stats.energyMax, c.stats.energyMax)
end

function World:addCell(kind: string, name: string, biomass: number?)
	local p = self:findSpawnPoint(30)
	local c = {
		id = self:id(),
		kind = kind,
		name = name,
		hue = self:rand(),
		alive = true,
		x = p.x,
		y = p.y,
		vx = 0,
		vy = 0,
		heading = self:rand() * TAU,
		biomass = biomass or Config.START_BIOMASS,
		xp = 0,
		level = 1,
		organelles = {},
		orgHealth = {},
		mutations = { vitality = 0, metabolism = 0 },
		infoVersion = 1,
		crackKey = "",
		input = { a = 0, t = 0 },
		dashCd = 0,
		dashTime = 0,
		toxinCd = 0,
		venomCd = 0,
		venomSurge = 0,
		cloudSlow = 0,
		poison = { stacks = 0, time = 0, dps = 0, slow = 0, source = 0 },
		bleed = { time = 0, dps = 0, source = 0 },
		spawnProtect = if kind == "player" then Config.SPAWN_PROTECTION else 0,
		evolveProtect = 0,
		evolveProtectGranted = false,
		evolving = false,
		pendingEvolutions = 0,
		offers = nil,
		lastHitBy = nil,
		lastHitAt = -1e9,
		lastHitKind = "",
		lastCombatAt = -1e9,
		regenActive = false,
		pairCooldown = {},
		kills = 0,
		bornAt = self.time,
		biomassCollected = 0,
		peakBiomass = biomass or Config.START_BIOMASS,
	}
	self:refreshStats(c)
	c.hp = c.stats.maxHp
	c.energy = c.stats.energyMax
	self.cells[c.id] = c
	return c
end

function World:removeCell(id: number)
	self.cells[id] = nil
	for _, c in self.cells do
		c.pairCooldown[id] = nil
	end
end

function World:pushEvent(ev)
	table.insert(self.events, ev)
end

-- ------------------------------------------------------------ abilities

function World:dash(c): boolean
	if not c.alive or c.dashCd > 0 or c.energy < Config.DASH_COST then
		return false
	end
	local ix, iy = Movement.dashImpulse(c, c.stats, c.input, c.level)
	c.vx += ix
	c.vy += iy
	c.energy -= Config.DASH_COST
	c.dashCd = Config.DASH_COOLDOWN * (if c.level >= Config.APEX_LEVEL then 0.7 else 1)
	c.dashTime = 0.45
	self:pushEvent({ e = "dash", id = c.id })
	return true
end

function World:toxin(c): boolean
	if not c.alive or #c.stats.toxins == 0 or c.toxinCd > 0 or c.energy < T.toxinCost then
		return false
	end
	if c.evolveProtect > 0 or c.spawnProtect > 0 then
		return false
	end
	c.energy -= T.toxinCost
	c.toxinCd = T.toxinCooldown
	for _, t in c.stats.toxins do
		local a = c.heading + t.dir
		local x = c.x + math.cos(a) * c.stats.radius * t.offset
		local y = c.y + math.sin(a) * c.stats.radius * t.offset
		local r = t.radius + c.stats.radius * (if t.offset == 0 then T.toxinCenterReach else 0.5)
		table.insert(self.clouds, { id = self:id(), owner = c.id, x = x, y = y, r = r, dps = t.dps, life = T.toxinDuration, maxLife = T.toxinDuration })
		self:pushEvent({ e = "toxin", id = c.id, x = x, y = y })
		-- Release burst: shove enemies inside outward (less for heavy cells).
		for _, o in self.cells do
			if o ~= c and o.alive and o.spawnProtect <= 0 then
				local dx, dy = o.x - x, o.y - y
				local d = math.sqrt(dx * dx + dy * dy)
				local reach = r + o.stats.radius * 0.6
				if d < reach then
					local k = T.toxinKnockback * (1 - d / reach) * (22 / o.stats.radius) ^ 0.35
					local nx = if d > 1 then dx / d else math.cos(c.heading)
					local ny = if d > 1 then dy / d else math.sin(c.heading)
					o.vx += nx * k
					o.vy += ny * k
				end
			end
		end
	end
	return true
end

function World:venom(c): boolean
	if not c.alive or c.venomCd > 0 or c.energy < T.venomSurgeCost then
		return false
	end
	local linked = false
	for _, d in c.stats.deliveries do
		if d.venom then
			linked = true
		end
	end
	if not linked then
		return false
	end
	c.energy -= T.venomSurgeCost
	c.venomCd = T.venomSurgeCooldown
	c.venomSurge = T.venomSurgeDuration
	self:pushEvent({ e = "venom", id = c.id })
	return true
end

-- ------------------------------------------------------------ organelle damage

local function crackStage(h): number
	if not h or h.max <= 0 then
		return 0
	end
	if h.regrow > 0 then
		return 3
	end
	local f = h.hp / h.max
	return if f > 0.66 then 0 elseif f > 0.33 then 1 else 2
end

function World:crackStages(c): { number }
	local out = {}
	for i, h in c.orgHealth do
		out[i] = crackStage(h)
	end
	return out
end

function World:publishCracks(c)
	local key = table.concat(self:crackStages(c), "")
	if key ~= c.crackKey then
		c.crackKey = key
		c.infoVersion += 1
	end
end

function World:damageOrganelle(c, index: number, amount: number)
	local h = c.orgHealth[index]
	if not h or h.max <= 0 or h.regrow > 0 or amount <= 0 or c.spawnProtect > 0 then
		return
	end
	if c.evolveProtect > 0 then
		amount *= 0.3
	end
	h.hp -= amount
	if h.hp <= 0 then
		h.hp = 0
		h.regrow = Organelles.REGROW_TIME
		self:refreshStats(c)
		self:pushEvent({ e = "break", id = c.id, x = c.x, y = c.y, type = c.organelles[index].type })
	end
	self:publishCracks(c)
end

local function coversAngle(o, localAngle: number): boolean
	if o.type == "membrane" then
		return math.abs(angleDiff(Placement.angle(o), localAngle)) <= T.membraneHalfArc
	elseif o.type == "spikes" then
		return math.abs(angleDiff(Placement.direction(o), localAngle)) <= T.spikeArc + 0.15
	elseif o.type == "stinger" then
		return math.abs(angleDiff(Placement.direction(o), localAngle)) <= T.stingerArc[o.level] + 0.15
	end
	return false
end

-- ------------------------------------------------------------ evolution

function World:combatLock(c): number
	return math.max(0, Config.EVOLVE_COMBAT_LOCK - (self.time - c.lastCombatAt))
end

function World:openEvolution(c)
	if not c.alive or c.pendingEvolutions <= 0 then
		return nil
	end
	if self:combatLock(c) > 0 then
		return nil -- queued until the cell has disengaged
	end
	if not c.offers then
		c.offers = Progression.generateOffers(c.level, c.organelles, self.rng)
	end
	c.evolving = true
	if not c.evolveProtectGranted then
		c.evolveProtectGranted = true
		c.evolveProtect = Config.EVOLVE_PROTECTION
	end
	return c.offers
end

function World:closeEvolution(c)
	c.evolving = false
	c.evolveProtect = 0
end

-- Validates and applies a choice. Returns an error string or nil.
function World:chooseEvolution(c, index: any, slot: any, tilt: any): string?
	if not c.alive or c.pendingEvolutions <= 0 or not c.offers then
		return "no evolution pending"
	end
	if typeof(index) ~= "number" or index ~= math.floor(index) then
		return "invalid offer"
	end
	local offer = c.offers[index]
	if not offer then
		return "invalid offer"
	end
	if offer.kind == "new" then
		local tl = if MathUtil.isFiniteNumber(tilt) then tilt else 0
		if Placement.isSurface(offer.type) then
			tl = clamp(math.round(tl / Placement.TILT_STEP) * Placement.TILT_STEP, -Placement.MAX_TILT, Placement.MAX_TILT)
		else
			tl = 0
		end
		local err = Placement.check(c.organelles, offer.type, slot, tl, Placement.capacityForLevel(c.level))
		if err then
			return "invalid placement: " .. err
		end
		table.insert(c.organelles, { type = offer.type, level = 1, slot = slot, tilt = tl })
	elseif offer.kind == "upgrade" then
		local o = c.organelles[offer.index]
		if not o or o.type ~= offer.type or o.level >= Progression.maxOrganelleLevel(c.level) then
			return "invalid upgrade"
		end
		o.level = math.min(3, o.level + 1)
	elseif offer.mutation == "growth" then
		self:addBiomass(c, 20)
	else
		c.mutations[offer.mutation] += 1
	end
	c.pendingEvolutions -= 1
	c.offers = nil
	c.evolveProtectGranted = false
	c.infoVersion += 1
	self:refreshStats(c)
	if c.pendingEvolutions > 0 then
		self:openEvolution(c)
	else
		c.evolving = false
		c.evolveProtect = 0
	end
	return nil
end

-- ------------------------------------------------------------ progression

function World:addXp(c, xp: number)
	c.xp += xp
	while c.level < Config.MAX_LEVEL and c.xp >= Progression.xpToNext(c.level) do
		c.xp -= Progression.xpToNext(c.level)
		c.level += 1
		c.pendingEvolutions += 1
		c.infoVersion += 1
		self:pushEvent({ e = "level", id = c.id, level = c.level })
		if c.level == Config.APEX_LEVEL then
			self:refreshStats(c)
		end
	end
end

function World:addBiomass(c, amount: number)
	local before = c.biomass
	c.biomass = math.min(Config.MAX_BIOMASS, c.biomass + amount)
	c.biomassCollected += c.biomass - before
	c.peakBiomass = math.max(c.peakBiomass, c.biomass)
	self:refreshStats(c)
end

-- ------------------------------------------------------------ damage

function World:damage(target, amount: number, source, kind: string, x: number, y: number, blocked: boolean)
	if not target.alive or amount <= 0 or target.spawnProtect > 0 then
		return
	end
	if target.evolveProtect > 0 then
		amount *= 0.3
	end
	local direct = kind ~= "dot" and kind ~= "acid" and kind ~= "toxin"
	if direct then
		amount = math.min(amount, target.stats.maxHp * Config.MAX_HIT_FRACTION)
	end
	target.hp -= amount
	target.lastCombatAt = self.time
	target.lastHitKind = kind
	local sourceId = if typeof(source) == "table" then source.id elseif typeof(source) == "number" then source else nil
	if sourceId then
		target.lastHitBy = sourceId
		target.lastHitAt = self.time
		local src = self.cells[sourceId]
		if src then
			src.lastCombatAt = self.time
		end
	end
	if direct then
		self:pushEvent({ e = "hit", x = x, y = y, target = target.id, source = sourceId or 0, amount = math.round(amount), kind = kind, blocked = blocked })
	else
		target.dotAccum = (target.dotAccum or 0) + amount
	end
end

-- Attacker strikes defender along unit normal (nx, ny) from att to def.
function World:resolveHit(att, def, nx: number, ny: number, closing: number): boolean
	if att.spawnProtect > 0 or att.evolveProtect > 0 or def.spawnProtect > 0 then
		return false
	end
	local contactAtt = angleDiff(att.heading, math.atan2(ny, nx))
	local contactDef = angleDiff(def.heading, math.atan2(-ny, -nx))
	local armor = Stats.armorMultiplier(def.stats, contactDef)
	local blocked = armor < 0.7
	local cx, cy = att.x + nx * att.stats.radius, att.y + ny * att.stats.radius
	local hit = false
	local raw = 0

	local del = Stats.deliveryAt(att.stats, contactAtt)
	if del and (del.kind == "stinger" or closing > 40) then
		local impact = clamp(0.35 + closing / 220, 0.35, 2)
		raw = del.damage * att.stats.sizeFactor * impact
		self:damage(def, raw * armor, att, if del.kind == "spikes" then "spike" else "sting", cx, cy, blocked)
		if del.bleed then
			def.bleed = { time = 3, dps = 3 * att.stats.sizeFactor * armor, source = att.id }
		end
		local surge = att.venomSurge > 0
		if del.venom and (surge or att.energy >= T.venomCost) then
			if not surge then
				att.energy -= T.venomCost
			end
			local active = def.poison.time > 0
			local add = if surge then 2 else 1
			def.poison.stacks = math.min(T.venomMaxStacks, (if active then def.poison.stacks else 0) + add)
			def.poison.dps = math.max(if active then def.poison.dps else 0, del.venom.dps)
			def.poison.slow = math.max(if active then def.poison.slow else 0, del.venom.slow)
			def.poison.time = T.venomDuration
			def.poison.source = att.id
		end
		if armor < 1 then
			self:damageOrganelle(att, del.index, raw * (1 - armor) * Organelles.SOAK.chipOnArmor)
		end
		hit = true
	end

	if closing > 90 then
		local ratio = clamp(math.sqrt(att.stats.mass / def.stats.mass), 0.25, 3)
		local bump = (closing - 90) * T.bumpFactor * ratio * armor
		if bump >= 0.5 then
			self:damage(def, bump, att, "bump", cx, cy, blocked)
			raw += bump / math.max(0.05, armor)
			hit = true
		end
	end
	if raw > 0 and def.spawnProtect <= 0 then
		for i, o in def.organelles do
			if coversAngle(o, contactDef) then
				self:damageOrganelle(def, i, raw * (if o.type == "membrane" then Organelles.SOAK.membrane else Organelles.SOAK.weapon))
			end
		end
	end
	return hit
end

-- ------------------------------------------------------------ step

function World:step(dt: number)
	self.time += dt
	for _, c in self.cells do
		if c.alive then
			self:updateCell(c, dt)
		end
	end
	self:collectNutrients()
	self:resolveCollisions()
	self:updateClouds(dt)
	local dead = {}
	for _, c in self.cells do
		if c.alive and c.hp <= 0 then
			table.insert(dead, c)
		end
	end
	for _, c in dead do
		self:kill(c)
	end
	self:replenish()
end

function World:updateCell(c, dt: number)
	local s = c.stats
	c.dashCd = math.max(0, c.dashCd - dt)
	c.dashTime = math.max(0, c.dashTime - dt)
	c.toxinCd = math.max(0, c.toxinCd - dt)
	c.venomCd = math.max(0, c.venomCd - dt)
	c.venomSurge = math.max(0, c.venomSurge - dt)
	c.spawnProtect = math.max(0, c.spawnProtect - dt)
	c.evolveProtect = math.max(0, c.evolveProtect - dt)
	if c.evolving and c.evolveProtect > 0 and c.input.t > 0.15 then
		c.evolveProtect = 0 -- steering ends editor protection
	end
	c.energy = math.min(s.energyMax, c.energy + s.energyRegen * dt)

	local slow = math.max(if c.poison.time > 0 then c.poison.slow else 0, c.cloudSlow)
	Movement.integrate(c, s, c.input, { slow = slow, evolving = c.evolving }, self.hazards, dt)
	for _, h in self.hazards do
		if h.kind == "acid" and math.sqrt((c.x - h.x) ^ 2 + (c.y - h.y) ^ 2) < h.r then
			self:damage(c, (5 + s.maxHp * 0.012) * dt, nil, "acid", c.x, c.y, false)
		end
	end

	if c.poison.time > 0 then
		c.poison.time -= dt
		self:damage(c, c.poison.dps * c.poison.stacks * dt, c.poison.source, "dot", c.x, c.y, false)
		if c.poison.time <= 0 then
			c.poison.stacks = 0
		end
	end
	if c.bleed.time > 0 then
		c.bleed.time -= dt
		self:damage(c, c.bleed.dps * dt, c.bleed.source, "dot", c.x, c.y, false)
	end
	c.dotTimer = (c.dotTimer or 0) + dt
	if c.dotTimer >= 0.6 then
		if (c.dotAccum or 0) >= 0.5 then
			self:pushEvent({ e = "hit", x = c.x, y = c.y, target = c.id, source = 0, amount = math.round(c.dotAccum), kind = "dot", blocked = false })
		end
		c.dotAccum = 0
		c.dotTimer = 0
	end

	local outOfCombat = self.time - c.lastCombatAt > Config.COMBAT_TIMEOUT
	-- Organelle regrowth / healing
	local changed = false
	for i, h in c.orgHealth do
		if h.max > 0 then
			if h.regrow > 0 then
				h.regrow -= dt
				if h.regrow <= 0 then
					h.regrow = 0
					h.hp = h.max
					self:refreshStats(c)
					self:pushEvent({ e = "regrow", id = c.id, type = c.organelles[i].type })
					changed = true
				end
			elseif outOfCombat and h.hp < h.max then
				h.hp = math.min(h.max, h.hp + h.max * Organelles.INTEGRITY_HEAL * dt)
				changed = true
			end
		end
	end
	if changed then
		self:publishCracks(c)
	end

	c.regenActive = false
	if c.hp < s.maxHp then
		if outOfCombat then
			c.hp += s.maxHp * 0.002 * dt
		end
		if s.regenFrac > 0 then
			local cost = T.regenEnergyPerSec * dt
			if c.energy >= cost then
				c.energy -= cost
				c.hp += s.regenFrac * s.maxHp * (if outOfCombat then 3 else 1) * dt
				c.regenActive = true
			end
		end
		c.hp = math.min(c.hp, s.maxHp)
	end

	if c.biomass > Config.BIOMASS_DECAY_START then
		c.biomass -= (c.biomass - Config.BIOMASS_DECAY_START) * Config.BIOMASS_DECAY_RATE * dt
		if math.floor(self.time * 2) ~= math.floor((self.time - dt) * 2) then
			self:refreshStats(c)
		end
	end
end

function World:collectNutrients()
	for _, c in self.cells do
		if c.alive then
			local r = c.stats.radius
			local eaten = {}
			self:queryNutrients(c.x - r - 10, c.y - r - 10, c.x + r + 10, c.y + r + 10, function(n)
				local nr = if n.kind == 5 then Config.CRYSTAL_RADIUS else Config.NUTRIENT_RADIUS
				if (n.x - c.x) ^ 2 + (n.y - c.y) ^ 2 < (r + nr * 0.4) ^ 2 then
					table.insert(eaten, n)
				end
			end)
			if #eaten > 0 then
				local gained, xp = 0, 0
				for _, n in eaten do
					self:removeNutrient(n)
					gained += n.value
					xp += n.xp
					self:pushEvent({ e = "eat", id = c.id, nutrient = n.id, crystal = n.kind == 5 })
				end
				self:addBiomass(c, gained)
				self:addXp(c, xp)
			end
		end
	end
end

function World:resolveCollisions()
	local list = {}
	for _, c in self.cells do
		if c.alive then
			table.insert(list, c)
		end
	end
	table.sort(list, function(p, q)
		return p.id < q.id
	end)
	for i = 1, #list do
		local A = list[i]
		for j = i + 1, #list do
			local B = list[j]
			local rs = A.stats.radius + B.stats.radius
			local dx, dy = B.x - A.x, B.y - A.y
			local d2 = dx * dx + dy * dy
			if d2 < rs * rs then
				local d = math.sqrt(d2)
				if d < 0.01 then
					d = 0.01
				end
				local nx, ny = dx / d, dy / d
				local overlap = rs - d
				local mA, mB = A.stats.mass, B.stats.mass
				local mt = mA + mB
				A.x -= nx * overlap * (mB / mt) * 0.85
				A.y -= ny * overlap * (mB / mt) * 0.85
				B.x += nx * overlap * (mA / mt) * 0.85
				B.y += ny * overlap * (mA / mt) * 0.85
				local closing = (A.vx - B.vx) * nx + (A.vy - B.vy) * ny
				if closing > 0 then
					local imp = (1.4 * closing) / (1 / mA + 1 / mB)
					A.vx -= imp / mA * nx
					A.vy -= imp / mA * ny
					B.vx += imp / mB * nx
					B.vy += imp / mB * ny
				end
				if closing > 15 and (A.pairCooldown[B.id] or -1) <= self.time then
					local ha = self:resolveHit(A, B, nx, ny, closing)
					local hb = self:resolveHit(B, A, -nx, -ny, closing)
					if ha or hb then
						A.pairCooldown[B.id] = self.time + Config.PAIR_HIT_COOLDOWN
					end
				end
			end
		end
	end
end

function World:updateClouds(dt: number)
	for _, c in self.cells do
		c.cloudSlow = 0
	end
	-- One owner's overlapping clouds never stack: each victim takes the strongest.
	local worst = {}
	for _, cl in self.clouds do
		cl.life -= dt
		for _, c in self.cells do
			if c.alive and c.id ~= cl.owner then
				local d = math.sqrt((c.x - cl.x) ^ 2 + (c.y - cl.y) ^ 2)
				if d < cl.r + c.stats.radius * 0.6 then
					local key = c.id * 100000 + cl.owner
					local cur = worst[key]
					if not cur or cl.dps > cur.dps then
						worst[key] = { c = c, owner = cl.owner, dps = cl.dps }
					end
					c.cloudSlow = T.toxinSlow
				end
			end
		end
	end
	for _, w in worst do
		self:damage(w.c, w.dps * dt, w.owner, "toxin", w.c.x, w.c.y, false)
	end
	local kept = {}
	for _, cl in self.clouds do
		if cl.life > 0 then
			table.insert(kept, cl)
		end
	end
	self.clouds = kept
end

function World:kill(victim)
	victim.alive = false
	local killer = nil
	if victim.lastHitBy and self.time - victim.lastHitAt < Config.KILL_CREDIT_WINDOW then
		killer = self.cells[victim.lastHitBy]
	end
	if killer and killer.alive and killer ~= victim then
		killer.kills += 1
		self:addBiomass(killer, victim.biomass * 0.35)
		self:addXp(killer, math.round(12 + victim.level * 10 + victim.biomass * 0.08))
		self:pushEvent({ e = "kill", killer = killer.name, victim = victim.name, how = victim.lastHitKind })
	else
		killer = nil
	end
	local count = clamp(math.round(victim.biomass * 0.45 / 2), 4, 70)
	for _ = 1, count do
		local n = self:spawnNutrient(false, victim, victim.stats.radius * 1.6)
		n.value = 2
	end
	if victim.level >= 4 then
		self:spawnNutrient(true, victim, victim.stats.radius)
	end
	self:pushEvent({ e = "death", id = victim.id, x = victim.x, y = victim.y, hue = victim.hue, r = victim.stats.radius })
	local stats = {
		survivalTime = self.time - victim.bornAt,
		level = victim.level,
		kills = victim.kills,
		biomassCollected = math.round(victim.biomassCollected),
		peakBiomass = math.round(victim.peakBiomass),
		killedBy = if killer then killer.name else nil,
		killerId = if killer then killer.id else nil,
	}
	self:removeCell(victim.id)
	self.onDeath(victim, stats)
end

function World:replenish()
	local budget = 30
	while budget > 0 and self.nutrientCount < Config.NUTRIENT_TARGET do
		self:spawnNutrient(false)
		budget -= 1
	end
	if self.crystalCount < Config.CRYSTAL_TARGET and self:rand() < 0.05 then
		self:spawnNutrient(true)
	end
	if self:rand() < 0.01 then
		local b = self.blooms[self.rng:NextInteger(1, #self.blooms)]
		b.x = self:rand() * self.size
		b.y = self:rand() * self.size
	end
end

return World
