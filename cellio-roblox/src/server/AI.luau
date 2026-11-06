-- AI organisms: same Cell, movement, combat and evolution rules as players.
-- Port of cell-io/shared/sim/ai.ts + tactics.ts (layout-aware fighting).
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("Shared")
local MathUtil = require(Shared.MathUtil)
local Organelles = require(Shared.Organelles)
local Placement = require(Shared.Placement)
local Progression = require(Shared.Progression)
local Movement = require(Shared.Movement)
local Stats = require(Shared.Stats)

local T = Organelles.TUNING
local angleDiff = MathUtil.angleDiff
local clamp = MathUtil.clamp
local PI = math.pi

local AI = {}

AI.POPULATION = { grazer = 6, prey = 8, predator = 4, defender = 3 }

local NAMES = {
	predator = { "Didinium", "Lacrymaria", "Coleps", "Dileptus", "Actinophrys" },
	defender = { "Arcella", "Difflugia", "Volvox", "Heliozoa", "Radiolaria" },
	grazer = { "Paramecium", "Euglena", "Stentor", "Vorticella", "Blepharisma" },
	prey = { "Chlorella", "Bodo", "Monas", "Chlamydo", "Colpoda" },
}

local START = {
	prey = { biomass = { 5, 12 }, level = { 1, 2 } },
	grazer = { biomass = { 12, 45 }, level = { 1, 3 } },
	predator = { biomass = { 30, 110 }, level = { 3, 7 } },
	defender = { biomass = { 40, 130 }, level = { 4, 8 } },
}

-- Preferred organelles per archetype and the local angles they mount at.
local BUILDS = {
	predator = {
		{ type = "spikes", angles = { 0, -PI / 8, PI / 8 } },
		{ type = "flagellum", angles = { PI } },
		{ type = "venom", angles = { 0 } },
		{ type = "stinger", angles = { -PI / 3, PI / 3 } },
		{ type = "cilia", angles = { PI * 0.75, -PI * 0.75 } },
		{ type = "mitochondria", angles = { PI }, center = true },
	},
	defender = {
		{ type = "membrane", angles = { 0, PI } },
		{ type = "toxin", angles = { 0 }, center = true },
		{ type = "regen", angles = { PI }, center = true },
		{ type = "mitochondria", angles = { PI / 3 } },
		{ type = "spikes", angles = { PI, PI * 0.8 } },
	},
	grazer = {
		{ type = "cilia", angles = { PI, PI * 0.75, -PI * 0.75, PI / 2 } },
		{ type = "mitochondria", angles = { 0 }, center = true },
		{ type = "membrane", angles = { PI } },
		{ type = "regen", angles = { 0 }, center = true },
	},
	prey = {
		{ type = "cilia", angles = { PI, PI * 0.8, -PI * 0.8 } },
		{ type = "flagellum", angles = { PI } },
		{ type = "membrane", angles = { PI } },
	},
}

function AI.difficultyFor(level: number, biomass: number): number
	return clamp((level - 2) / 12 + biomass / 2400, 0, 1)
end

local function countType(c, t: string): number
	local n = 0
	for _, o in c.organelles do
		if o.type == t then
			n += 1
		end
	end
	return n
end

local function findBuild(build, t: string)
	for i, b in build do
		if b.type == t then
			return b, i
		end
	end
	return nil, nil
end

function AI.autoEvolve(world, c)
	local guard = 20
	while c.pendingEvolutions > 0 and guard > 0 do
		guard -= 1
		local offers = world:openEvolution(c)
		if not offers then
			break
		end
		local build = BUILDS[c.ai.archetype]
		local bestI, bestScore = 1, -math.huge
		for i, o in offers do
			local s
			if o.kind == "mutation" then
				s = if o.mutation == "vitality" then 1.5 else 1
			else
				local b, idx = findBuild(build, o.type)
				local pref = if idx then 10 - idx else 0
				if o.kind == "upgrade" then
					s = pref * 0.8 + 1
				else
					local maxCount = if b then #b.angles else 1
					local cnt = countType(c, o.type)
					s = if cnt >= maxCount then 0.5 else pref - cnt * 1.5
				end
			end
			if s > bestScore then
				bestI, bestScore = i, s
			end
		end
		local o = offers[bestI]
		local slot = nil
		if o.kind == "new" then
			local b = findBuild(build, o.type)
			local cnt = countType(c, o.type)
			local angle = if b then b.angles[(cnt % #b.angles) + 1] else world:rand() * MathUtil.TAU
			slot = Placement.nearestValidSlot(c.organelles, o.type, angle, b and b.center and cnt == 0)
		end
		if world:chooseEvolution(c, bestI, slot, 0) then
			-- Fall back to any offer that needs no placement.
			local alt = nil
			for i, x in offers do
				if x.kind ~= "new" then
					alt = i
				end
			end
			if not alt or world:chooseEvolution(c, alt, nil, 0) then
				break
			end
		end
	end
	world:closeEvolution(c)
end

function AI.spawn(world, archetype: string)
	local spec = START[archetype]
	local names = NAMES[archetype]
	local biomass = spec.biomass[1] + world:rand() * (spec.biomass[2] - spec.biomass[1])
	local c = world:addCell("ai", names[world.rng:NextInteger(1, #names)], biomass)
	c.hue = ({ prey = 0.28, grazer = 0.5, predator = 0.0, defender = 0.6 })[archetype] + (world:rand() - 0.5) * 0.08
	c.ai = { archetype = archetype, think = 0, targetId = nil, wander = world:rand() * MathUtil.TAU, mode = "graze", chase = 0, rest = 0, retreatUntil = 0 }
	local boost = math.round(world.aiDifficulty * (if archetype == "predator" or archetype == "defender" then 5 else 2))
	local level = math.round(spec.level[1] + world:rand() * (spec.level[2] - spec.level[1])) + boost
	while c.level < level do
		world:addXp(c, Progression.xpToNext(c.level) - c.xp)
	end
	AI.autoEvolve(world, c)
	c.hp = c.stats.maxHp
	c.energy = c.stats.energyMax
	return c
end

-- ------------------------------------------------------------ tactics

local function readLayout(c)
	local s = c.stats
	local weapon, armor = nil, nil
	for _, d in s.deliveries do
		if not weapon or d.damage > weapon.damage then
			weapon = d
		end
	end
	for _, a in s.armor do
		if not armor or a.reduction > armor.reduction then
			armor = a
		end
	end
	local px, py, mag = Stats.propulsion(s)
	local pdir = math.atan2(py, px)
	local venomLinked = false
	for _, d in s.deliveries do
		if d.venom then
			venomLinked = true
		end
	end
	return {
		weapon = weapon,
		armor = armor,
		rearWeapon = weapon ~= nil and math.abs(angleDiff(weapon.dir, PI)) < PI / 3,
		kiter = mag >= 0.3 and math.abs(angleDiff(pdir, 0)) < PI / 3,
		hasToxin = #s.toxins > 0,
		venomLinked = venomLinked,
	}
end

local function dashAngle(c, a: number, t: number): number
	local ix, iy = Movement.dashImpulse(c, c.stats, { a = a, t = t }, c.level)
	return math.atan2(iy, ix)
end

local function avoidClouds(world, c, a: number, t: number, target, L): (number, number)
	local px, py = 0, 0
	for _, cl in world.clouds do
		if cl.owner ~= c.id then
			local dx, dy = c.x - cl.x, c.y - cl.y
			local d = math.max(1, math.sqrt(dx * dx + dy * dy))
			local edge = cl.r + c.stats.radius * 0.6 + 20 + 40 * world.aiDifficulty
			if d < edge then
				local w = (edge - d) / edge
				px += dx / d * w
				py += dy / d * w
			end
		end
	end
	if px == 0 and py == 0 then
		return a, t
	end
	local gap = math.sqrt((target.x - c.x) ^ 2 + (target.y - c.y) ^ 2) - c.stats.radius - target.stats.radius
	local toTarget = math.atan2(target.y - c.y, target.x - c.x)
	if gap < 25 and L.weapon and math.abs(angleDiff(c.heading + L.weapon.dir, toTarget)) < 0.4 then
		return a, t -- committed to an aimed hit
	end
	return math.atan2(math.sin(a) + py * 3, math.cos(a) + px * 3), 1
end

local function evade(world, c, threat, L): (number, number)
	local dx, dy = threat.x - c.x, threat.y - c.y
	local d = math.max(1, math.sqrt(dx * dx + dy * dy))
	local gap = d - c.stats.radius - threat.stats.radius
	local ang = math.atan2(dy, dx)
	local away = ang + PI
	if L.hasToxin and gap < (c.stats.toxins[1].radius * 0.6) then
		world:toxin(c)
	end
	if L.rearWeapon and gap < 150 then
		return away, if gap < 60 then 0.3 else 0.8 -- let the chaser run onto rear spikes
	end
	if L.armor and not L.kiter and gap < 90 then
		return ang - L.armor.dir, 0.25 -- turn the plates toward the threat
	end
	if gap < 90 + 40 * world.aiDifficulty and c.energy > 30 and math.abs(angleDiff(dashAngle(c, away, 1), away)) < 0.8 then
		world:dash(c)
	end
	return away, 1
end

local function engage(world, c, target): (number, number)
	local L = readLayout(c)
	local diff = world.aiDifficulty
	local dx, dy = target.x - c.x, target.y - c.y
	local d = math.max(1, math.sqrt(dx * dx + dy * dy))
	local gap = d - c.stats.radius - target.stats.radius
	local lead = clamp(d / 450, 0, 0.7)
	local ang = math.atan2(target.y + target.vy * lead - c.y, target.x + target.vx * lead - c.x)
	local away = ang + PI
	local ai = c.ai

	if L.kiter and target.lastHitBy == c.id and world.time - target.lastHitAt < 0.2 then
		ai.retreatUntil = world.time + 1.1 - 0.4 * diff
	end
	if c.hp / c.stats.maxHp < 0.3 and target.hp / target.stats.maxHp > c.hp / c.stats.maxHp + 0.15 then
		return evade(world, c, target, L)
	end
	if world.time < ai.retreatUntil then
		if gap > 260 then
			ai.retreatUntil = 0
		end
		if gap < 80 and math.abs(angleDiff(dashAngle(c, away, 1), away)) < 0.6 then
			world:dash(c)
		end
		return away, 1
	end
	if L.hasToxin and gap < c.stats.toxins[1].radius * (0.55 + 0.25 * diff) then
		world:toxin(c)
	end
	if not L.weapon then
		if L.hasToxin then
			local ready = c.toxinCd <= 0 and c.energy >= T.toxinCost
			local closing = -((target.vx - c.vx) * dx + (target.vy - c.vy) * dy) / d
			if ready and closing > 30 then
				return (if L.armor then ang - L.armor.dir else ang), 0.15
			elseif ready then
				return ang, 1
			end
			if L.armor and gap < 120 then
				return ang - L.armor.dir, 0.2
			end
			return away, if gap < 160 then 0.9 else 0.3
		end
		if L.armor and gap < 180 then
			return ang - L.armor.dir, 0.2
		end
		return away, if gap < 250 then 1 else 0.4
	end
	if L.rearWeapon and gap < 280 then
		local closing = -((target.vx - c.vx) * dx + (target.vy - c.vy) * dy) / d
		return ang - L.weapon.dir, if closing > 40 and gap < 140 then 0.25 else 0.7
	end
	-- Read the target's layout: hover outside a ready toxin gland, flank its armor.
	local theirs = readLayout(target)
	local charging = theirs.weapon ~= nil and gap < 140 and math.abs(angleDiff(target.heading + theirs.weapon.dir, ang + PI)) < 0.5
	if theirs.hasToxin and not charging and target.toxinCd <= 0.5 and target.energy >= T.toxinCost and gap < 150 + 60 * diff then
		return ang + (if gap < 110 then 2.2 else 1.6) * (if c.id % 2 == 1 then 1 else -1), 1
	end
	local aim = ang
	if theirs.armor and gap > 30 then
		local rel = angleDiff(target.heading + theirs.armor.dir, ang + PI)
		if math.abs(rel) < T.membraneHalfArc + 0.2 then
			aim = ang + (if rel > 0 then -1 else 1) * (0.5 + 0.4 * diff) * math.min(1, gap / 120)
		end
	end
	local a = aim - L.weapon.dir
	local aligned = math.abs(angleDiff(c.heading + L.weapon.dir, ang)) < 0.35
	if L.venomLinked and aligned and gap < 200 and c.energy > T.venomSurgeCost + 20 then
		world:venom(c)
	end
	if aligned and gap < 110 + 70 * diff and c.energy > 40 and math.abs(angleDiff(dashAngle(c, a, 1), ang)) < 0.4 then
		if world:rand() < 0.5 + 0.5 * diff then
			world:dash(c)
		end
	end
	return a, 1
end

local function threatLevel(self, other): number
	local armed = if #other.stats.deliveries > 0 then 1.3 else 1
	return (other.stats.radius / self.stats.radius) * armed * (if other.level >= self.level then 1.1 else 0.9)
end

function AI.update(world, c, dt: number)
	local ai = c.ai
	if c.pendingEvolutions > 0 then
		AI.autoEvolve(world, c)
	end
	local diff = world.aiDifficulty
	ai.think -= dt
	if ai.mode == "hunt" then
		ai.chase += dt
	end
	ai.rest = math.max(0, ai.rest - dt)
	if ai.chase > 6 + 5 * diff then
		ai.chase = 0
		ai.rest = 7 - 4 * diff
		ai.targetId = nil
	end
	if ai.think > 0 then
		return
	end
	ai.think = 0.32 - 0.18 * diff + world:rand() * 0.1

	local R = c.stats.radius
	local sense = 420 + R * 3
	local fx, fy = 0, 0
	local closestThreat, closestD = nil, math.huge
	local prey, preyScore = nil, -math.huge
	for _, o in world.cells do
		if o ~= c and o.alive then
			local dx, dy = o.x - c.x, o.y - c.y
			local d = math.sqrt(dx * dx + dy * dy)
			if d <= sense and d > 0 then
				local gap = d - R - o.stats.radius
				local threat = threatLevel(c, o)
				local fearful = ({ prey = 0.9, grazer = 1.05, defender = 1.6, predator = 1.35 })[ai.archetype]
				if threat > fearful and gap < 260 + o.stats.radius then
					local w = threat / math.max(30, gap) * 100
					fx -= dx / d * w
					fy -= dy / d * w
					if gap < closestD then
						closestD, closestThreat = gap, o
					end
				end
				local grace = o.kind == "player" and o.level <= 2
				if ai.archetype == "predator" and ai.rest <= 0 and not grace and o.spawnProtect <= 0 and o.evolveProtect <= 0 and o.stats.radius < R * 1.3 then
					local score = -gap * 0.01 - o.hp / math.max(1, o.stats.maxHp) - #o.stats.armor * 0.3 + (if o.id == ai.targetId then 0.5 else 0)
					if score > preyScore then
						preyScore, prey = score, o
					end
				end
			end
		end
	end

	-- Avoid acid pools and walls.
	local ax, ay = 0, 0
	for _, h in world.hazards do
		if h.kind == "acid" then
			local dx, dy = c.x - h.x, c.y - h.y
			local d = math.max(1, math.sqrt(dx * dx + dy * dy))
			if d < h.r + R + 90 then
				ax += dx / d * 2
				ay += dy / d * 2
			end
		end
	end
	local m = 150 + R
	if c.x < m then
		ax += 1.5
	end
	if c.y < m then
		ay += 1.5
	end
	if c.x > world.size - m then
		ax -= 1.5
	end
	if c.y > world.size - m then
		ay -= 1.5
	end

	local lowHp = c.hp < c.stats.maxHp * 0.35
	local a, t
	local L = readLayout(c)
	local standGround = closestThreat and closestD < 120 and not lowHp and (L.rearWeapon or (ai.archetype == "defender" and L.armor))
	if closestThreat and (ai.archetype ~= "predator" or lowHp or closestD < 60) then
		ai.mode = "flee"
		if closestD < 150 then
			if standGround then
				a, t = engage(world, c, closestThreat)
			else
				a, t = evade(world, c, closestThreat, L)
			end
			a, t = avoidClouds(world, c, a, t, closestThreat, L)
		else
			a, t = math.atan2(fy, fx), 1
		end
	elseif prey and not lowHp then
		if ai.targetId ~= prey.id then
			ai.chase = 0
		end
		ai.mode = "hunt"
		ai.targetId = prey.id
		a, t = engage(world, c, prey)
		a, t = avoidClouds(world, c, a, t, prey, L)
	else
		ai.mode = "graze"
		local best, bestScore = nil, math.huge
		local range = 260 + R * 2
		world:queryNutrients(c.x - range, c.y - range, c.x + range, c.y + range, function(n)
			local s = math.sqrt((n.x - c.x) ^ 2 + (n.y - c.y) ^ 2) / (if n.kind == 5 then 4 else 1)
			if s < bestScore then
				best, bestScore = n, s
			end
		end)
		if best then
			a = math.atan2(best.y - c.y, best.x - c.x)
		else
			ai.wander += (world:rand() - 0.5) * 0.8
			a = ai.wander
		end
		t = if ai.archetype == "defender" then 0.55 else 0.8
	end
	-- Blend in hazard / wall avoidance.
	local dirX, dirY = math.cos(a) + ax, math.sin(a) + ay
	c.input.a = math.atan2(dirY, dirX)
	c.input.t = t
end

return AI
