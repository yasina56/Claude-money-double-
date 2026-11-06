-- Client-side rendering. Everything is built from plain parts on this client
-- only (nothing replicates back). Simulation (x, y) maps to world (X, Z) at
-- Config.STUDS_PER_UNIT; the camera looks straight down, screen-up = -Z, so
-- the layout matches the web version (y grows downward on screen).
local Lighting = game:GetService("Lighting")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local TweenService = game:GetService("TweenService")
local Workspace = game:GetService("Workspace")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local Config = require(Shared.Config)
local Organelles = require(Shared.Organelles)
local Placement = require(Shared.Placement)
local Strategy = require(Shared.Strategy)

local S = Config.STUDS_PER_UNIT
local TUNING = Organelles.TUNING

local Renderer = {}

local root = Instance.new("Folder")
root.Name = "CellIOView"
root.Parent = Workspace

local function newPart(class: string?, props): BasePart
	local p = Instance.new(class or "Part") :: BasePart
	p.Anchored = true
	p.CanCollide = false
	p.CanQuery = false
	p.CanTouch = false
	p.CastShadow = false
	p.TopSurface = Enum.SurfaceType.Smooth
	p.BottomSurface = Enum.SurfaceType.Smooth
	p.Material = Enum.Material.SmoothPlastic
	for k, v in props do
		(p :: any)[k] = v
	end
	p.Parent = props.Parent or root
	return p
end

local function toWorld(x: number, y: number, h: number?): Vector3
	return Vector3.new(x * S, h or 0, y * S)
end

-- Rotation so that local +X points along simulation angle `a`.
local function yaw(a: number): CFrame
	return CFrame.Angles(0, -a, 0)
end

local FLAT = CFrame.Angles(0, 0, math.pi / 2) -- cylinder axis -> vertical

-- Two mirrored WedgeParts make an isosceles triangle seen from above.
local function makeTriangle(color: Color3, transparency: number?)
	local a = newPart("WedgePart", { Color = color, Transparency = transparency or 0 })
	local b = newPart("WedgePart", { Color = color, Transparency = transparency or 0 })
	return { a, b }
end

-- CFrames for the two halves: base centre `pos`, pointing along world angle `dir`.
local function triangleCFrames(pos: Vector3, dir: number, width: number, length: number): (CFrame, CFrame)
	local f = Vector3.new(math.cos(dir), 0, math.sin(dir))
	local side = Vector3.new(-math.sin(dir), 0, math.cos(dir))
	local up = Vector3.new(0, 1, 0)
	local mid = pos + f * (length / 2)
	-- A WedgePart's cross-section (local Y/Z) is a right triangle whose thin
	-- tip is at local -Z on the -Y edge. Map -Z to the spike direction and the
	-- -Y edge onto the centre line, so the two halves meet in one point.
	-- (Both frames are right-handed: X x Y = Z.)
	local a = CFrame.fromMatrix(mid + side * (width / 4), -up, side, -f)
	local b = CFrame.fromMatrix(mid - side * (width / 4), up, -side, -f)
	return a, b
end


-- ------------------------------------------------------------ static world
function Renderer.buildWorld(hazards)
	for _, c in root:GetChildren() do
		if c.Name == "World" then
			c:Destroy()
		end
	end
	local world = Instance.new("Folder")
	world.Name = "World"
	world.Parent = root
	local size = Config.WORLD_SIZE * S
	newPart(nil, { Name = "Floor", Size = Vector3.new(size + 40, 1, size + 40), CFrame = CFrame.new(size / 2, -1.2, size / 2), Color = Color3.fromRGB(8, 34, 42), Parent = world })
	-- Faint grid
	for i = 0, Config.WORLD_SIZE, 240 do
		local v = i * S
		newPart(nil, { Size = Vector3.new(0.12, 0.05, size), CFrame = CFrame.new(v, -0.68, size / 2), Color = Color3.fromRGB(40, 110, 120), Transparency = 0.7, Parent = world })
		newPart(nil, { Size = Vector3.new(size, 0.05, 0.12), CFrame = CFrame.new(size / 2, -0.68, v), Color = Color3.fromRGB(40, 110, 120), Transparency = 0.7, Parent = world })
	end
	-- Glowing border
	for _, spec in { { size / 2, 0, size, 0.8 }, { size / 2, size, size, 0.8 }, { 0, size / 2, 0.8, size }, { size, size / 2, 0.8, size } } do
		newPart(nil, { Size = Vector3.new(spec[3], 0.4, spec[4]), CFrame = CFrame.new(spec[1], -0.4, spec[2]), Color = Color3.fromRGB(94, 242, 214), Material = Enum.Material.Neon, Parent = world })
	end
	for _, h in hazards do
		if h.kind == "acid" then
			newPart(nil, { Shape = Enum.PartType.Cylinder, Size = Vector3.new(0.2, h.r * 2 * S, h.r * 2 * S), CFrame = CFrame.new(toWorld(h.x, h.y, -0.55)) * FLAT, Color = Color3.fromRGB(122, 214, 42), Material = Enum.Material.Neon, Transparency = 0.75, Parent = world })
		else
			newPart(nil, { Shape = Enum.PartType.Cylinder, Size = Vector3.new(0.1, h.r * 2 * S, h.r * 2 * S), CFrame = CFrame.new(toWorld(h.x, h.y, -0.6)) * FLAT, Color = Color3.fromRGB(111, 214, 255), Transparency = 0.9, Parent = world })
			-- Arrow showing the current's direction
			local tri = makeTriangle(Color3.fromRGB(159, 232, 255), 0.6)
			local a, b = triangleCFrames(toWorld(h.x, h.y, -0.5), h.dir, 4, 6)
			for i, cf in { a, b } do
				tri[i].Size = Vector3.new(0.1, 2, 6)
				tri[i].CFrame = cf
				tri[i].Parent = world
			end
		end
	end
	Lighting.Ambient = Color3.fromRGB(120, 160, 170)
	Lighting.OutdoorAmbient = Color3.fromRGB(120, 160, 170)
	Lighting.Brightness = 1.5
	Lighting.ClockTime = 12
end

-- ------------------------------------------------------------ cells
local views = {} -- id -> view

local function hueColor(h: number, s: number, v: number): Color3
	return Color3.fromHSV(h % 1, s, v)
end

local function clearOrganelleParts(v)
	for _, p in v.orgParts do
		p:Destroy()
	end
	v.orgParts = {}
	v.orgSpecs = {}
end

local function damagedColor(c: Color3, stage: number): Color3
	if stage == 1 then
		return c:Lerp(Color3.fromRGB(110, 90, 80), 0.35)
	elseif stage >= 2 then
		return c:Lerp(Color3.fromRGB(70, 60, 55), 0.6)
	end
	return c
end

-- (Re)build organelle parts from the latest layout.
local function buildOrganelles(v, info)
	clearOrganelleParts(v)
	for i, o in info.organelles do
		local stage = info.cracks and info.cracks[i] or 0
		local def = Organelles.DEFS[o.type]
		local spec = { o = o, stage = stage, parts = {} }
		local color = damagedColor(def.color, stage)
		local transp = if stage >= 3 then 0.65 else 0
		if o.type == "spikes" or o.type == "stinger" then
			spec.parts = makeTriangle(color, transp)
			if o.type == "stinger" then
				table.insert(spec.parts, newPart(nil, { Shape = Enum.PartType.Ball, Color = Color3.fromRGB(192, 77, 255), Material = Enum.Material.Neon, Transparency = transp }))
			end
		elseif o.type == "membrane" then
			for _ = 1, 4 do
				table.insert(spec.parts, newPart(nil, { Color = color, Transparency = transp }))
			end
		elseif o.type == "cilia" then
			for _ = 1, 5 + o.level do
				table.insert(spec.parts, newPart(nil, { Color = def.color, Material = Enum.Material.Neon, Transparency = 0.2 }))
			end
		elseif o.type == "flagellum" then
			for _ = 1, 8 do
				table.insert(spec.parts, newPart(nil, { Shape = Enum.PartType.Ball, Color = def.color, Material = Enum.Material.Neon }))
			end
		else -- internal organelles: glowing beads
			local p = newPart(nil, { Shape = Enum.PartType.Ball, Color = def.color, Material = Enum.Material.Neon, Transparency = 0.1 })
			table.insert(spec.parts, p)
		end
		for _, p in spec.parts do
			table.insert(v.orgParts, p)
		end
		table.insert(v.orgSpecs, spec)
	end
end

local function makeLabel(v, adornee: BasePart)
	local bb = Instance.new("BillboardGui")
	bb.Size = UDim2.fromOffset(200, 54)
	bb.StudsOffsetWorldSpace = Vector3.new(0, 0, 0)
	bb.AlwaysOnTop = true
	bb.LightInfluence = 0
	bb.Adornee = adornee
	bb.Parent = adornee
	local name = Instance.new("TextLabel")
	name.Size = UDim2.new(1, 0, 0, 20)
	name.BackgroundTransparency = 1
	name.Font = Enum.Font.GothamBlack
	name.TextSize = 15
	name.TextColor3 = Color3.new(1, 1, 1)
	name.TextStrokeTransparency = 0.3
	name.Parent = bb
	local badge = Instance.new("TextLabel")
	badge.Size = UDim2.new(1, 0, 0, 14)
	badge.Position = UDim2.fromOffset(0, 20)
	badge.BackgroundTransparency = 1
	badge.Font = Enum.Font.GothamBlack
	badge.TextSize = 11
	badge.TextStrokeTransparency = 0.4
	badge.Parent = bb
	local barBg = Instance.new("Frame")
	barBg.Size = UDim2.new(0.5, 0, 0, 6)
	barBg.Position = UDim2.new(0.25, 0, 0, 38)
	barBg.BackgroundColor3 = Color3.new(0, 0, 0)
	barBg.BackgroundTransparency = 0.4
	barBg.BorderSizePixel = 0
	barBg.Parent = bb
	local bar = Instance.new("Frame")
	bar.Size = UDim2.fromScale(1, 1)
	bar.BackgroundColor3 = Color3.fromRGB(255, 93, 122)
	bar.BorderSizePixel = 0
	bar.Parent = barBg
	v.label, v.nameText, v.badgeText, v.barBg, v.bar = bb, name, badge, barBg, bar
end

local function newView(id: number)
	local v = { id = id, orgParts = {}, orgSpecs = {}, version = -1, seed = (id * 2.39996) % (math.pi * 2) }
	v.body = newPart(nil, { Shape = Enum.PartType.Cylinder, Transparency = 0.35 })
	v.rim = newPart(nil, { Shape = Enum.PartType.Cylinder, Material = Enum.Material.Neon, Transparency = 0.35 })
	v.nucleus = newPart(nil, { Shape = Enum.PartType.Ball, Transparency = 0.15 })
	v.anchor = newPart(nil, { Transparency = 1, Size = Vector3.new(0.2, 0.2, 0.2) })
	makeLabel(v, v.anchor)
	views[id] = v
	return v
end

local function destroyView(id: number)
	local v = views[id]
	if not v then
		return
	end
	clearOrganelleParts(v)
	v.body:Destroy()
	v.rim:Destroy()
	v.nucleus:Destroy()
	v.anchor:Destroy()
	views[id] = nil
end
Renderer.destroyView = destroyView

function Renderer.viewOf(id: number)
	return views[id]
end

-- Per-frame update of one cell. Appends parts/CFrames for BulkMoveTo.
local function updateCell(v, s, info, t: number, parts, cfs, mine: boolean)
	local R = s.radius * S
	local h = s.heading
	local cx, cz = s.x * S, s.y * S
	local center = Vector3.new(cx, 0, cz)
	local hue = if info then info.hue else 0.5
	local poisoned = bit32.band(s.flags, 4) ~= 0
	local protected = bit32.band(s.flags, 1) ~= 0
	local evolving = bit32.band(s.flags, 2) ~= 0
	local surge = bit32.band(s.flags, 256) ~= 0
	local pulse = 1 + 0.03 * math.sin(t * 3 + v.seed)

	v.body.Size = Vector3.new(0.3, R * 2 * pulse, R * 2 * pulse)
	v.body.Color = if poisoned then hueColor(0.25, 0.7, 0.75) else hueColor(hue, 0.55, 0.8)
	v.rim.Size = Vector3.new(0.18, R * 2.1 * pulse, R * 2.1 * pulse)
	v.rim.Color = if evolving then Color3.fromRGB(255, 226, 122) elseif protected then Color3.new(1, 1, 1) else hueColor(hue, 0.5, 1)
	v.rim.Transparency = if protected then 0.2 + 0.3 * math.abs(math.sin(t * 6)) else 0.35
	v.nucleus.Size = Vector3.one * R * 0.5 * (1 + 0.06 * math.sin(t * 2.4 + v.seed))
	v.nucleus.Color = hueColor(hue + 0.08, 0.6, 0.45)
	table.insert(parts, v.body)
	table.insert(cfs, CFrame.new(center + Vector3.new(0, 0.1, 0)) * FLAT)
	table.insert(parts, v.rim)
	table.insert(cfs, CFrame.new(center + Vector3.new(0, -0.05, 0)) * FLAT)
	table.insert(parts, v.nucleus)
	local nl = Vector3.new(math.cos(h + math.pi) * R * 0.12, 0.3, math.sin(h + math.pi) * R * 0.12)
	table.insert(cfs, CFrame.new(center + nl))
	table.insert(parts, v.anchor)
	table.insert(cfs, CFrame.new(center + Vector3.new(0, 1, R * 1.45)))

	local centerTaken = false
	for _, spec in v.orgSpecs do
		local o = spec.o
		local at = Placement.angle(o)
		local dir = Placement.direction(o)
		local worldAt = h + at
		local worldDir = h + dir
		local base = center + Vector3.new(math.cos(worldAt) * R, 0.2, math.sin(worldAt) * R)
		local broken = spec.stage >= 3
		if o.type == "spikes" or o.type == "stinger" then
			local L = (if o.type == "spikes" then TUNING.spikeLength[o.level] else 0.5 + 0.06 * o.level) * R * (if broken then 0.3 else 1)
			local W = (if o.type == "spikes" then 0.26 + 0.04 * o.level else 0.12) * R
			spec.parts[1].Size = Vector3.new(0.25, W / 2, L)
			spec.parts[2].Size = Vector3.new(0.25, W / 2, L)
			local a, b = triangleCFrames(base - Vector3.new(math.cos(worldDir), 0, math.sin(worldDir)) * R * 0.05, worldDir, W, L)
			table.insert(parts, spec.parts[1])
			table.insert(cfs, a)
			table.insert(parts, spec.parts[2])
			table.insert(cfs, b)
			if spec.parts[3] then
				spec.parts[3].Size = Vector3.one * math.max(0.25, R * 0.1)
				spec.parts[3].Transparency = if surge then 0 else 0.3
				table.insert(parts, spec.parts[3])
				table.insert(cfs, CFrame.new(base + Vector3.new(math.cos(worldDir), 0, math.sin(worldDir)) * L))
			end
		elseif o.type == "membrane" then
			local half = TUNING.membraneHalfArc
			local n = #spec.parts
			local thick = (0.1 + 0.035 * o.level) * R
			for k = 1, n do
				local th = worldAt - half + (k - 0.5) * (2 * half / n)
				local p = spec.parts[k]
				local seg = 2 * half / n * R * 1.08
				p.Size = Vector3.new(thick, 0.3, seg)
				p.Transparency = if broken then 0.8 else 0
				table.insert(parts, p)
				local pos = center + Vector3.new(math.cos(th) * (R + thick / 2), 0.15, math.sin(th) * (R + thick / 2))
				table.insert(cfs, CFrame.new(pos) * yaw(th))
			end
		elseif o.type == "cilia" then
			local tilt = dir - at
			local n = #spec.parts
			for k = 1, n do
				local th = worldAt + ((k - 1) / math.max(1, n - 1) - 0.5) * 0.5
				local beat = math.sin(t * 14 + k * 0.9 + v.seed) * 0.35
				local len = (0.2 + 0.05 * o.level) * R
				local a = th + tilt + beat * 0.5
				local p = spec.parts[k]
				p.Size = Vector3.new(len, 0.12, 0.12)
				local root = center + Vector3.new(math.cos(th) * R * 0.98, 0.1, math.sin(th) * R * 0.98)
				table.insert(parts, p)
				table.insert(cfs, CFrame.new(root + Vector3.new(math.cos(a), 0, math.sin(a)) * len / 2) * yaw(a))
			end
		elseif o.type == "flagellum" then
			local L = (1.5 + 0.2 * o.level) * R
			local n = #spec.parts
			local fx, fz = math.cos(worldDir), math.sin(worldDir)
			local nx, nz = -fz, fx
			local speed = math.sqrt(s.vx * s.vx + s.vy * s.vy)
			local freq = 8 + math.min(14, speed / 20)
			for k = 1, n do
				local f = k / n
				local lat = math.sin(f * 7 - t * freq) * 0.16 * f * R
				local p = spec.parts[k]
				p.Size = Vector3.one * math.max(0.2, R * (0.16 - 0.1 * f))
				table.insert(parts, p)
				table.insert(cfs, CFrame.new(base + Vector3.new(fx * f * L + nx * lat, 0, fz * f * L + nz * lat)))
			end
		else
			local slot = Placement.internal(o.slot)
			if o.slot == 0 then
				centerTaken = true
			end
			local wa = h + slot.a
			local p = spec.parts[1]
			local pul = if o.type == "regen" then 1 + 0.12 * math.sin(t * 3 + o.slot) else 1
			p.Size = Vector3.one * R * (if o.type == "mitochondria" then 0.28 else 0.3) * pul
			table.insert(parts, p)
			table.insert(cfs, CFrame.new(center + Vector3.new(math.cos(wa) * slot.r * R * 0.95, 0.35, math.sin(wa) * slot.r * R * 0.95)))
		end
	end
	v.nucleus.Transparency = if centerTaken then 1 else 0.15

	-- Label + health bar
	if info then
		local key = `{info.name}|{info.level}|{#info.organelles}|{info.version or 0}`
		if key ~= v.labelKey then
			v.labelKey = key
			v.nameText.Text = `{info.name} · {info.level}`
			v.nameText.TextColor3 = if mine then Color3.fromRGB(255, 226, 122) elseif info.ai then Color3.fromRGB(191, 233, 240) else Color3.new(1, 1, 1)
			local strat = Strategy.classify(info.organelles)
			v.badgeText.Text = if strat then string.upper(strat) else ""
			v.badgeText.TextColor3 = if strat then Strategy.COLORS[strat] else Color3.new(1, 1, 1)
		end
	end
	v.bar.Size = UDim2.fromScale(math.clamp(s.hp, 0, 1), 1)
	v.bar.BackgroundColor3 = if poisoned then Color3.fromRGB(157, 255, 61) else Color3.fromRGB(255, 93, 122)
	v.barBg.Visible = s.hp < 0.995 or mine
end

-- ------------------------------------------------------------ nutrients
local nutrientParts = {} -- id -> part
local NUTRIENT_COLORS = {
	[0] = Color3.fromRGB(125, 255, 178),
	[1] = Color3.fromRGB(255, 227, 107),
	[2] = Color3.fromRGB(255, 138, 216),
	[3] = Color3.fromRGB(138, 216, 255),
	[4] = Color3.fromRGB(255, 168, 107),
}

function Renderer.removeNutrients(ids)
	for _, id in ids do
		local p = nutrientParts[id]
		if p then
			nutrientParts[id] = nil
			p:Destroy()
		end
	end
end

-- Eaten nutrients fly into the eater and vanish.
function Renderer.eatNutrient(nutrientId: number, eaterId: number)
	local p = nutrientParts[nutrientId]
	if not p then
		return
	end
	nutrientParts[nutrientId] = nil
	local v = views[eaterId]
	if v then
		local tw = TweenService:Create(p, TweenInfo.new(0.14), { Position = v.body.Position, Size = Vector3.one * 0.1 })
		tw:Play()
		tw.Completed:Once(function()
			p:Destroy()
		end)
	else
		p:Destroy()
	end
end

local function syncNutrients(nutrients, t: number)
	for id, n in nutrients do
		local p = nutrientParts[id]
		if not p then
			if n.kind == 5 then
				p = newPart(nil, { Size = Vector3.new(1.4, 1.4, 1.4), Color = Color3.fromRGB(159, 252, 255), Material = Enum.Material.Neon })
			else
				p = newPart(nil, { Shape = Enum.PartType.Ball, Size = Vector3.one * 1.1, Color = NUTRIENT_COLORS[n.kind] or NUTRIENT_COLORS[0], Material = Enum.Material.Neon })
			end
			nutrientParts[id] = p
		end
		local bob = math.sin(t * 1.3 + id * 0.7) * 0.15
		p.CFrame = CFrame.new(n.x * S + bob, 0.2, n.y * S) * (if n.kind == 5 then CFrame.Angles(0, t + id, math.pi / 4) else CFrame.identity)
	end
end

-- ------------------------------------------------------------ clouds + effects
local cloudParts = {}

local function syncClouds(clouds, t: number)
	local seen = {}
	for _, c in clouds do
		seen[c.id] = true
		local p = cloudParts[c.id]
		if not p then
			p = newPart(nil, { Shape = Enum.PartType.Cylinder, Color = Color3.fromRGB(158, 214, 30), Material = Enum.Material.Neon })
			cloudParts[c.id] = p
		end
		local d = c.r * 2 * S * (1 + 0.03 * math.sin(t * 3 + c.id))
		p.Size = Vector3.new(0.6, d, d)
		p.Transparency = 1 - 0.35 * math.min(1, c.life * 2.5)
		p.CFrame = CFrame.new(c.x * S, 0.6, c.y * S) * FLAT
	end
	for id, p in cloudParts do
		if not seen[id] then
			p:Destroy()
			cloudParts[id] = nil
		end
	end
end

local fxPart = newPart(nil, { Transparency = 1, Size = Vector3.one * 0.2 })
local emitter = Instance.new("ParticleEmitter")
emitter.Enabled = false
emitter.Lifetime = NumberRange.new(0.35, 0.8)
emitter.Speed = NumberRange.new(8, 22)
emitter.SpreadAngle = Vector2.new(180, 180)
emitter.Size = NumberSequence.new({ NumberSequenceKeypoint.new(0, 0.6), NumberSequenceKeypoint.new(1, 0) })
emitter.LightEmission = 1
emitter.Drag = 4
emitter.Parent = fxPart

function Renderer.burst(x: number, y: number, n: number, color: Color3)
	fxPart.CFrame = CFrame.new(x * S, 0.8, y * S)
	emitter.Color = ColorSequence.new(color)
	emitter:Emit(math.clamp(math.floor(n), 1, 60))
end

function Renderer.damageNumber(x: number, y: number, amount: number, color: Color3, big: boolean)
	local a = newPart(nil, { Transparency = 1, Size = Vector3.one * 0.1, CFrame = CFrame.new(x * S, 1, y * S) })
	local bb = Instance.new("BillboardGui")
	bb.Size = UDim2.fromOffset(80, 30)
	bb.AlwaysOnTop = true
	bb.LightInfluence = 0
	bb.Parent = a
	local tl = Instance.new("TextLabel")
	tl.Size = UDim2.fromScale(1, 1)
	tl.BackgroundTransparency = 1
	tl.Font = Enum.Font.GothamBlack
	tl.TextSize = if big then 22 else 15
	tl.TextColor3 = color
	tl.TextStrokeTransparency = 0.2
	tl.Text = tostring(amount)
	tl.Parent = bb
	TweenService:Create(a, TweenInfo.new(0.85, Enum.EasingStyle.Cubic), { CFrame = a.CFrame + Vector3.new(0, 0, -3) }):Play()
	TweenService:Create(tl, TweenInfo.new(0.85), { TextTransparency = 1, TextStrokeTransparency = 1 }):Play()
	task.delay(0.9, function()
		a:Destroy()
	end)
end

-- ------------------------------------------------------------ frame
-- `cells`: interpolated records by id. Returns nothing; moves everything.
function Renderer.frame(cells, infos, nutrients, clouds, myId: number, t: number)
	local parts, cfs = {}, {}
	for id, s in cells do
		local v = views[id] or newView(id)
		v.missing = 0
		local info = infos[id]
		-- Rebuild organelle parts whenever the server bumps the cell's layout
		-- version (new organelle, upgrade, crack stage change, level up).
		local layoutKey = if info then `{info.version or 0}|{#info.organelles}` else 
		if info and layoutKey ~= v.layoutKey then
			v.layoutKey = layoutKey
			buildOrganelles(v, info)
		end
		updateCell(v, s, info, t, parts, cfs, id == myId)
	end
	Workspace:BulkMoveTo(parts, cfs, Enum.BulkMoveMode.FireCFrameChanged)
	for id, v in views do
		if not cells[id] then
			v.missing = (v.missing or 0) + 1
			if v.missing > 20 then
				destroyView(id)
			end
		end
	end
	syncNutrients(nutrients, t)
	syncClouds(clouds, t)
end

return Renderer
