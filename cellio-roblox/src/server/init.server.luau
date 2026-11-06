-- CELL.IO server entry point: authoritative simulation + networking.
-- Clients only send intent (steering, abilities, evolution choices); every
-- argument is validated and rate limited here.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local TextService = game:GetService("TextService")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local Config = require(Shared.Config)
local MathUtil = require(Shared.MathUtil)
local Placement = require(Shared.Placement)
local Progression = require(Shared.Progression)
local World = require(script.World)
local AI = require(script.AI)

Players.CharacterAutoLoads = false -- players are cells, not avatars

-- ------------------------------------------------------------ remotes
local remotes = Instance.new("Folder")
remotes.Name = "Remotes"
local function remote(name: string, unreliable: boolean?)
	local r = Instance.new(if unreliable then "UnreliableRemoteEvent" else "RemoteEvent")
	r.Name = name
	r.Parent = remotes
	return r
end
local R = {
	Play = remote("Play"),
	Input = remote("Input", true),
	Ability = remote("Ability"),
	EvolveOpen = remote("EvolveOpen"),
	EvolveClose = remote("EvolveClose"),
	EvolveChoose = remote("EvolveChoose"),
	Welcome = remote("Welcome"),
	Snapshot = remote("Snapshot"),
	Events = remote("Events"),
	Offer = remote("Offer"),
	EvolveResult = remote("EvolveResult"),
	Died = remote("Died"),
	Leaderboard = remote("Leaderboard"),
}
remotes.Parent = ReplicatedStorage

-- ------------------------------------------------------------ rate limiting
local function newLimiter(capacity: number, windowSeconds: number)
	local refill = capacity / windowSeconds
	local buckets = {}
	Players.PlayerRemoving:Connect(function(p)
		buckets[p] = nil
	end)
	return function(player: Player): boolean
		local now = os.clock()
		local b = buckets[player]
		if not b then
			b = { tokens = capacity, last = now }
			buckets[player] = b
		else
			b.tokens = math.min(capacity, b.tokens + (now - b.last) * refill)
			b.last = now
		end
		if b.tokens >= 1 then
			b.tokens -= 1
			return true
		end
		return false
	end
end
local allowInput = newLimiter(40, 1)
local allowAbility = newLimiter(8, 1)
local allowEvolve = newLimiter(10, 1)
local allowPlay = newLimiter(3, 5)

-- ------------------------------------------------------------ world
local world = World.new()
local clients = {} -- Player -> client state
local aiRespawn = {}

for arch, n in AI.POPULATION do
	for _ = 1, n do
		AI.spawn(world, arch)
	end
end

world.onDeath = function(cell, stats)
	if cell.kind == "ai" then
		table.insert(aiRespawn, { archetype = cell.ai.archetype, at = world.time + 3 + world:rand() * 5 })
		return
	end
	for player, cl in clients do
		if cl.cellId == cell.id then
			cl.cellId = nil
			cl.lastPos = { x = cell.x, y = cell.y }
			if stats.killerId then
				cl.spectate = { id = stats.killerId, untilTime = world.time + 3 }
			end
			R.Died:FireClient(player, stats)
		end
	end
end

local function cellOf(player: Player)
	local cl = clients[player]
	return cl and cl.cellId and world.cells[cl.cellId]
end

local function spawnPlayer(player: Player)
	local cl = clients[player]
	local old = cl.cellId and world.cells[cl.cellId]
	if old then
		world:removeCell(old.id)
	end
	local c = world:addCell("player", cl.name)
	cl.cellId = c.id
	cl.known = {}
	cl.knownNutrients = {}
	cl.nutrientsFull = true
	cl.spectate = nil
	R.Welcome:FireClient(player, { id = c.id, worldSize = world.size, hazards = world.hazards })
end

local function filteredName(player: Player): string
	local name = player.DisplayName
	local ok, result = pcall(function()
		local f = TextService:FilterStringAsync(name, player.UserId)
		return f:GetNonChatStringForBroadcastAsync()
	end)
	return string.sub(if ok then result else player.Name, 1, 20)
end

Players.PlayerAdded:Connect(function(player)
	clients[player] = { name = filteredName(player), cellId = nil, lastPos = { x = world.size / 2, y = world.size / 2 }, known = {}, knownNutrients = {}, nutrientsFull = true }
	R.Welcome:FireClient(player, { id = 0, worldSize = world.size, hazards = world.hazards })
end)
for _, p in Players:GetPlayers() do
	clients[p] = { name = filteredName(p), cellId = nil, lastPos = { x = world.size / 2, y = world.size / 2 }, known = {}, knownNutrients = {}, nutrientsFull = true }
end
Players.PlayerRemoving:Connect(function(player)
	local c = cellOf(player)
	if c then
		world:removeCell(c.id)
	end
	clients[player] = nil
end)

-- ------------------------------------------------------------ remote handlers
R.Play.OnServerEvent:Connect(function(player)
	if not allowPlay(player) or not clients[player] then
		return
	end
	if not cellOf(player) then
		spawnPlayer(player)
	end
end)

R.Input.OnServerEvent:Connect(function(player, a: unknown, t: unknown)
	if not allowInput(player) then
		return
	end
	local c = cellOf(player)
	if not c or not MathUtil.isFiniteNumber(a) or not MathUtil.isFiniteNumber(t) then
		return
	end
	c.input.a = a :: number
	c.input.t = math.clamp(t :: number, 0, 1)
end)

R.Ability.OnServerEvent:Connect(function(player, key: unknown)
	if not allowAbility(player) then
		return
	end
	local c = cellOf(player)
	if not c then
		return
	end
	if key == "dash" then
		world:dash(c)
	elseif key == "toxin" then
		world:toxin(c)
	elseif key == "venom" then
		world:venom(c)
	end
end)

R.EvolveOpen.OnServerEvent:Connect(function(player)
	if not allowEvolve(player) then
		return
	end
	local c = cellOf(player)
	if not c then
		return
	end
	local offers = world:openEvolution(c)
	if offers then
		R.Offer:FireClient(player, { offers = offers, protectedFor = c.evolveProtect })
	end
end)

R.EvolveClose.OnServerEvent:Connect(function(player)
	local c = cellOf(player)
	if c then
		world:closeEvolution(c)
	end
end)

R.EvolveChoose.OnServerEvent:Connect(function(player, index: unknown, slot: unknown, tilt: unknown)
	if not allowEvolve(player) then
		return
	end
	local c = cellOf(player)
	if not c then
		return
	end
	local err = world:chooseEvolution(c, index, slot, if tilt == nil then 0 else tilt)
	R.EvolveResult:FireClient(player, err == nil, err)
	if not err and c.offers then
		R.Offer:FireClient(player, { offers = c.offers, protectedFor = c.evolveProtect })
	end
end)

-- ------------------------------------------------------------ snapshots
local function flagsOf(c): number
	local f = 0
	if c.spawnProtect > 0 then f += 1 end
	if c.evolving then f += 2 end
	if c.poison.time > 0 then f += 4 end
	if c.dashTime > 0 then f += 8 end
	if c.kind == "ai" then f += 16 end
	if c.regenActive then f += 32 end
	if c.bleed.time > 0 then f += 128 end
	if c.venomSurge > 0 then f += 256 end
	return f
end

local function r1(v: number): number
	return math.round(v * 10) / 10
end

local function privateState(c)
	local hasVenom = false
	for _, d in c.stats.deliveries do
		if d.venom then
			hasVenom = true
		end
	end
	return {
		hp = r1(c.hp), maxHp = math.round(c.stats.maxHp), energy = r1(c.energy), energyMax = math.round(c.stats.energyMax),
		xp = math.floor(c.xp), xpNext = Progression.xpToNext(c.level), level = c.level, biomass = r1(c.biomass), kills = c.kills,
		pendingEvolutions = c.pendingEvolutions, dashCd = r1(c.dashCd), toxinCd = r1(c.toxinCd), venomCd = r1(c.venomCd),
		hasToxin = #c.stats.toxins > 0, hasVenom = hasVenom, combatLock = r1(world:combatLock(c)),
		capacity = Placement.capacityForLevel(c.level), capacityUsed = Placement.capacityUsed(c.organelles),
		protectedFor = r1(math.max(c.spawnProtect, c.evolveProtect)), radius = c.stats.radius,
	}
end

local function sendSnapshot(player: Player, cl, events, sendNutrients: boolean)
	local me = cl.cellId and world.cells[cl.cellId]
	if not me and cl.spectate then
		local k = world.cells[cl.spectate.id]
		if k and k.alive and world.time < cl.spectate.untilTime then
			cl.lastPos = { x = k.x, y = k.y }
		else
			cl.spectate = nil
		end
	end
	local cx = if me then me.x else cl.lastPos.x
	local cy = if me then me.y else cl.lastPos.y
	local half = Config.viewHalfExtent(if me then me.stats.radius else 40)
	local function inView(x: number, y: number, r: number): boolean
		return math.abs(x - cx) < half + r and math.abs(y - cy) < half + r
	end

	local cells, infos = {}, {}
	for _, c in world.cells do
		if c.alive and inView(c.x, c.y, c.stats.radius * 2) then
			table.insert(cells, { c.id, r1(c.x), r1(c.y), math.round(c.heading * 100) / 100, r1(c.stats.radius), math.round(c.hp / c.stats.maxHp * 100) / 100, flagsOf(c), math.round(c.vx), math.round(c.vy) })
			if cl.known[c.id] ~= c.infoVersion then
				cl.known[c.id] = c.infoVersion
				local orgs = {}
				for i, o in c.organelles do
					orgs[i] = { type = o.type, level = o.level, slot = o.slot, tilt = o.tilt }
				end
				table.insert(infos, { id = c.id, name = c.name, hue = c.hue, level = c.level, ai = c.kind == "ai", organelles = orgs, cracks = world:crackStages(c), version = c.infoVersion })
			end
		end
	end

	local snap = { t = world.time, cells = cells, infos = infos, you = if me then privateState(me) else nil, clouds = {} }
	for _, cloud in world.clouds do
		if inView(cloud.x, cloud.y, cloud.r) then
			table.insert(snap.clouds, { cloud.id, math.round(cloud.x), math.round(cloud.y), math.round(cloud.r), math.round(cloud.life / cloud.maxLife * 100) / 100 })
		end
	end
	if sendNutrients or cl.nutrientsFull then
		local visible, add, del = {}, {}, {}
		world:queryNutrients(cx - half, cy - half, cx + half, cy + half, function(n)
			visible[n.id] = true
			if not cl.knownNutrients[n.id] then
				table.insert(add, { n.id, math.round(n.x), math.round(n.y), n.kind })
			end
		end)
		for id in cl.knownNutrients do
			if not visible[id] then
				table.insert(del, id)
			end
		end
		cl.knownNutrients = visible
		snap.nFull = cl.nutrientsFull
		cl.nutrientsFull = false
		snap.nAdd = add
		snap.nDel = del
	end
	R.Snapshot:FireClient(player, snap)

	local mine = {}
	for _, ev in events do
		local keep
		if ev.e == "kill" then
			keep = true
		elseif ev.x then
			keep = inView(ev.x, ev.y, 100)
		else
			local c = world.cells[ev.id]
			keep = ev.id == cl.cellId or (c ~= nil and inView(c.x, c.y, 0))
		end
		if keep then
			table.insert(mine, ev)
		end
	end
	if #mine > 0 then
		R.Events:FireClient(player, mine)
	end
end

-- ------------------------------------------------------------ loop
local STEP = 1 / Config.TICK_RATE
local acc, tick, lbTimer = 0, 0, 0

RunService.Heartbeat:Connect(function(dt)
	acc = math.min(acc + dt, STEP * 4) -- never spiral after a stall
	while acc >= STEP do
		acc -= STEP
		for _, c in world.cells do
			if c.ai and c.alive then
				AI.update(world, c, STEP)
			end
		end
		world:step(STEP)
		tick += 1

		local keep = {}
		for _, q in aiRespawn do
			if q.at <= world.time then
				AI.spawn(world, q.archetype)
			else
				table.insert(keep, q)
			end
		end
		aiRespawn = keep

		if tick % Config.SNAPSHOT_EVERY == 0 then
			local events = world.events
			world.events = {}
			local nutrients = tick % Config.NUTRIENT_EVERY == 0
			for player, cl in clients do
				sendSnapshot(player, cl, events, nutrients)
			end
		end

		lbTimer += STEP
		if lbTimer >= 1 then
			lbTimer = 0
			-- Bot difficulty follows the strongest human (rises fast, eases off slowly).
			local target = 0.15
			for _, c in world.cells do
				if c.kind == "player" and c.alive then
					target = math.max(target, AI.difficultyFor(c.level, c.biomass))
				end
			end
			world.aiDifficulty += (target - world.aiDifficulty) * (if target > world.aiDifficulty then 0.5 else 0.1)
			local list = {}
			for _, c in world.cells do
				if c.alive then
					table.insert(list, c)
				end
			end
			table.sort(list, function(p, q)
				return p.biomass > q.biomass
			end)
			local top = {}
			for i = 1, math.min(10, #list) do
				local c = list[i]
				table.insert(top, { id = c.id, name = c.name, biomass = math.round(c.biomass), level = c.level, kills = c.kills })
			end
			R.Leaderboard:FireAllClients(top)
		end
	end
end)

print("CELL.IO server running")
