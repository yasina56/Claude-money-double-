-- All screen UI, built in code: menu, HUD, evolution panel with the
-- organelle placement editor, and the death screen.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local Organelles = require(Shared.Organelles)
local Placement = require(Shared.Placement)
local Progression = require(Shared.Progression)
local Stats = require(Shared.Stats)

local UI = {}

local ACCENT = Color3.fromRGB(94, 242, 214)
local GOLD = Color3.fromRGB(255, 212, 94)
local PANEL = Color3.fromRGB(8, 28, 36)
local TEXT = Color3.fromRGB(230, 251, 255)
local MUTED = Color3.fromRGB(143, 184, 194)

local gui = Instance.new("ScreenGui")
gui.Name = "CellIO"
gui.ResetOnSpawn = false
gui.IgnoreGuiInset = true
gui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
gui.Parent = Players.LocalPlayer:WaitForChild("PlayerGui")

local function make(class: string, props, children)
	local inst = Instance.new(class)
	for k, v in props do
		if k ~= "Parent" then
			(inst :: any)[k] = v
		end
	end
	for _, c in children or {} do
		c.Parent = inst
	end
	inst.Parent = props.Parent
	return inst
end

local function corner(r: number)
	return make("UICorner", { CornerRadius = UDim.new(0, r) })
end

local function panel(props)
	props.BackgroundColor3 = props.BackgroundColor3 or PANEL
	props.BackgroundTransparency = props.BackgroundTransparency or 0.2
	props.BorderSizePixel = 0
	return make("Frame", props, { corner(12), make("UIStroke", { Color = ACCENT, Transparency = 0.8, Thickness = 1 }) })
end

local function label(props)
	props.BackgroundTransparency = 1
	props.Font = props.Font or Enum.Font.GothamMedium
	props.TextColor3 = props.TextColor3 or TEXT
	props.TextSize = props.TextSize or 14
	props.TextXAlignment = props.TextXAlignment or Enum.TextXAlignment.Left
	props.TextWrapped = if props.TextWrapped == nil then true else props.TextWrapped
	return make("TextLabel", props)
end

local function button(props, onClick)
	props.BackgroundColor3 = props.BackgroundColor3 or Color3.fromRGB(30, 60, 70)
	props.AutoButtonColor = true
	props.Font = props.Font or Enum.Font.GothamBold
	props.TextColor3 = props.TextColor3 or TEXT
	props.TextSize = props.TextSize or 16
	props.BorderSizePixel = 0
	local b = make("TextButton", props, { corner(10) })
	b.Activated:Connect(onClick)
	return b
end

-- ------------------------------------------------------------ menu
local menu = panel({ Size = UDim2.fromOffset(560, 420), Position = UDim2.fromScale(0.5, 0.5), AnchorPoint = Vector2.new(0.5, 0.5), Parent = gui })
make("UISizeConstraint", { MaxSize = Vector2.new(560, 420), Parent = menu })
label({ Text = "CELL<font color=\"#ffd45e\">.IO</font>", RichText = true, Font = Enum.Font.GothamBlack, TextSize = 64, TextColor3 = ACCENT, TextXAlignment = Enum.TextXAlignment.Center, Size = UDim2.new(1, 0, 0, 80), Position = UDim2.fromOffset(0, 16), Parent = menu })
label({ Text = "Grow. Evolve. Design your organism.", TextColor3 = MUTED, TextSize = 18, TextXAlignment = Enum.TextXAlignment.Center, Size = UDim2.new(1, 0, 0, 24), Position = UDim2.fromOffset(0, 96), Parent = menu })
local playBtn
label({
	Text = "<b>Steer</b>: mouse (or hold a finger on the screen)   <b>Space</b>: dash\n<b>Q</b>: toxin cloud   <b>R</b>: venom surge   <b>E</b>: evolve\n\nEat nutrients to grow and level up. Each level, pick an organelle and <b>attach it where you want</b>: front spikes ram, rear spikes punish chasers, armor only protects the side it covers, a flagellum pushes away from where it sits.",
	RichText = true,
	TextColor3 = TEXT,
	TextSize = 15,
	Size = UDim2.new(1, -48, 0, 150),
	Position = UDim2.fromOffset(24, 136),
	TextYAlignment = Enum.TextYAlignment.Top,
	Parent = menu,
})
playBtn = button({ Text = "Play", Font = Enum.Font.GothamBlack, TextSize = 24, BackgroundColor3 = ACCENT, TextColor3 = Color3.fromRGB(3, 42, 38), Size = UDim2.fromOffset(200, 56), Position = UDim2.new(0.5, -100, 1, -88), Parent = menu }, function()
	UI.callbacks.onPlay()
end)

-- ------------------------------------------------------------ HUD
local hud = make("Frame", { BackgroundTransparency = 1, Size = UDim2.fromScale(1, 1), Visible = false, Parent = gui })
local stats = panel({ Size = UDim2.fromOffset(260, 170), Position = UDim2.fromOffset(12, 12), Parent = hud })
local levelText = label({ Font = Enum.Font.GothamBlack, TextSize = 20, TextColor3 = GOLD, Size = UDim2.new(1, -20, 0, 24), Position = UDim2.fromOffset(10, 6), Parent = stats })
local function bar(y: number, color: Color3)
	local bg = make("Frame", { BackgroundColor3 = Color3.new(0, 0, 0), BackgroundTransparency = 0.5, BorderSizePixel = 0, Size = UDim2.new(1, -20, 0, 16), Position = UDim2.fromOffset(10, y), Parent = stats }, { corner(8) })
	local fill = make("Frame", { BackgroundColor3 = color, BorderSizePixel = 0, Size = UDim2.fromScale(0.5, 1), Parent = bg }, { corner(8) })
	local txt = label({ Size = UDim2.fromScale(1, 1), TextXAlignment = Enum.TextXAlignment.Center, TextSize = 11, Font = Enum.Font.GothamBold, Parent = bg })
	txt.TextStrokeTransparency = 0.4
	return fill, txt
end
local hpFill, hpText = bar(34, Color3.fromRGB(255, 93, 122))
local enFill, enText = bar(54, Color3.fromRGB(255, 196, 60))
local xpFill, xpText = bar(74, Color3.fromRGB(80, 200, 255))
local capText = label({ TextColor3 = MUTED, TextSize = 12, Size = UDim2.new(1, -20, 0, 16), Position = UDim2.fromOffset(10, 94), Parent = stats })
local orgText = label({ TextSize = 12, Size = UDim2.new(1, -20, 0, 44), Position = UDim2.fromOffset(10, 112), TextYAlignment = Enum.TextYAlignment.Top, RichText = true, Parent = stats })
local protectText = label({ TextColor3 = Color3.fromRGB(255, 247, 194), Font = Enum.Font.GothamBold, TextSize = 12, Size = UDim2.new(1, -20, 0, 14), Position = UDim2.fromOffset(10, 152), Parent = stats })

local lbPanel = panel({ Size = UDim2.fromOffset(220, 250), Position = UDim2.new(1, -232, 0, 12), Parent = hud })
label({ Text = "LEADERBOARD", TextColor3 = ACCENT, Font = Enum.Font.GothamBlack, TextSize = 13, Size = UDim2.new(1, -20, 0, 18), Position = UDim2.fromOffset(10, 8), Parent = lbPanel })
local lbText = label({ RichText = true, TextSize = 13, Size = UDim2.new(1, -20, 1, -34), Position = UDim2.fromOffset(10, 28), TextYAlignment = Enum.TextYAlignment.Top, Parent = lbPanel })
local feed = label({ RichText = true, TextSize = 12, TextXAlignment = Enum.TextXAlignment.Right, TextYAlignment = Enum.TextYAlignment.Top, Size = UDim2.fromOffset(260, 100), Position = UDim2.new(1, -272, 0, 270), Parent = hud })
local feedLines = {}
local toastText = label({ Font = Enum.Font.GothamBlack, TextSize = 28, TextColor3 = GOLD, TextXAlignment = Enum.TextXAlignment.Center, Size = UDim2.new(1, 0, 0, 70), Position = UDim2.fromScale(0, 0.16), RichText = true, Parent = hud })
toastText.TextStrokeTransparency = 0.3
local spectateText = label({ Font = Enum.Font.GothamBlack, TextSize = 20, TextColor3 = Color3.fromRGB(255, 173, 185), TextXAlignment = Enum.TextXAlignment.Center, Size = UDim2.new(1, 0, 0, 30), Position = UDim2.new(0, 0, 1, -130), Visible = false, Parent = hud })

local abilityBar = make("Frame", { BackgroundTransparency = 1, Size = UDim2.fromOffset(340, 70), Position = UDim2.new(0.5, -170, 1, -84), Parent = hud }, {
	make("UIListLayout", { FillDirection = Enum.FillDirection.Horizontal, Padding = UDim.new(0, 10), HorizontalAlignment = Enum.HorizontalAlignment.Center }),
})
local abilityButtons = {}
for _, spec in { { "dash", "Dash", "Space" }, { "toxin", "Toxin", "Q" }, { "venom", "Venom", "R" }, { "evolve", "Evolve", "E" } } do
	local key, name, hint = spec[1], spec[2], spec[3]
	local b = button({ Text = "", Size = UDim2.fromOffset(76, 64), BackgroundColor3 = PANEL, Parent = abilityBar }, function()
		if key == "evolve" then
			UI.callbacks.onEvolveOpen()
		else
			UI.callbacks.onAbility(key)
		end
	end)
	label({ Text = hint, TextColor3 = MUTED, TextSize = 10, TextXAlignment = Enum.TextXAlignment.Center, Size = UDim2.new(1, 0, 0, 14), Position = UDim2.fromOffset(0, 8), Parent = b })
	label({ Text = name, Font = Enum.Font.GothamBlack, TextSize = 15, TextXAlignment = Enum.TextXAlignment.Center, Size = UDim2.new(1, 0, 0, 20), Position = UDim2.fromOffset(0, 26), Parent = b })
	local cd = make("Frame", { BackgroundColor3 = Color3.new(0, 0, 0), BackgroundTransparency = 0.45, BorderSizePixel = 0, AnchorPoint = Vector2.new(0, 1), Position = UDim2.fromScale(0, 1), Size = UDim2.fromScale(1, 0), Parent = b })
	abilityButtons[key] = { button = b, cd = cd }
end

-- ------------------------------------------------------------ evolution panel
local evo = panel({ Size = UDim2.fromOffset(860, 520), Position = UDim2.fromScale(0.5, 0.5), AnchorPoint = Vector2.new(0.5, 0.5), Visible = false, BackgroundTransparency = 0.05, Parent = gui })
make("UISizeConstraint", { MaxSize = Vector2.new(860, 520), Parent = evo })
local evoTitle = label({ Text = "Evolution", Font = Enum.Font.GothamBlack, TextSize = 26, TextColor3 = GOLD, Size = UDim2.new(1, -220, 0, 34), Position = UDim2.fromOffset(18, 12), Parent = evo })
local evoProtect = label({ TextColor3 = Color3.fromRGB(255, 247, 194), Font = Enum.Font.GothamBold, TextSize = 13, Size = UDim2.fromOffset(200, 18), Position = UDim2.new(1, -330, 0, 20), Parent = evo })
button({ Text = "Later", Size = UDim2.fromOffset(90, 34), Position = UDim2.new(1, -108, 0, 12), Parent = evo }, function()
	UI.hideEvolution()
	UI.callbacks.onEvolveClose()
end)
local cardsFrame = make("Frame", { BackgroundTransparency = 1, Size = UDim2.new(1, -36, 1, -70), Position = UDim2.fromOffset(18, 56), Parent = evo }, {
	make("UIListLayout", { FillDirection = Enum.FillDirection.Horizontal, Padding = UDim.new(0, 12) }),
})
local editor = make("Frame", { BackgroundTransparency = 1, Size = UDim2.new(1, -36, 1, -70), Position = UDim2.fromOffset(18, 56), Visible = false, Parent = evo })

local PREVIEW = 300
local R_PREVIEW = 100
local cellView = make("Frame", { BackgroundColor3 = Color3.fromRGB(20, 60, 70), BackgroundTransparency = 0.3, Size = UDim2.fromOffset(PREVIEW, PREVIEW), Position = UDim2.fromOffset(0, 20), Parent = editor }, { corner(PREVIEW // 2) })
local cellBody = make("Frame", { BackgroundColor3 = Color3.fromRGB(110, 210, 140), BackgroundTransparency = 0.45, Size = UDim2.fromOffset(R_PREVIEW * 2, R_PREVIEW * 2), AnchorPoint = Vector2.new(0.5, 0.5), Position = UDim2.fromScale(0.5, 0.5), Parent = cellView }, {
	corner(R_PREVIEW),
	make("UIStroke", { Color = Color3.fromRGB(190, 255, 210), Thickness = 3 }),
})
label({ Text = "FRONT ▶", Font = Enum.Font.GothamBlack, TextSize = 13, TextColor3 = MUTED, Size = UDim2.fromOffset(80, 16), Position = UDim2.new(1, -80, 0.5, -30), Parent = cellView })
label({ Text = "REAR", Font = Enum.Font.GothamBlack, TextSize = 13, TextColor3 = MUTED, Size = UDim2.fromOffset(60, 16), Position = UDim2.new(0, 6, 0.5, -30), Parent = cellView })
local slotLayer = make("Frame", { BackgroundTransparency = 1, Size = UDim2.fromScale(1, 1), Parent = cellView })
local tiltRow = make("Frame", { BackgroundTransparency = 1, Size = UDim2.fromOffset(PREVIEW, 36), Position = UDim2.fromOffset(0, PREVIEW + 30), Parent = editor })
local tiltText = label({ Text = "Tilt 0°", TextXAlignment = Enum.TextXAlignment.Center, Size = UDim2.fromOffset(100, 36), Position = UDim2.fromOffset(100, 0), Font = Enum.Font.GothamBold, Parent = tiltRow })
local edName = label({ Font = Enum.Font.GothamBlack, TextSize = 20, TextColor3 = ACCENT, Size = UDim2.new(1, -330, 0, 26), Position = UDim2.fromOffset(330, 16), Parent = editor })
local edDesc = label({ TextSize = 14, Size = UDim2.new(1, -330, 0, 40), Position = UDim2.fromOffset(330, 44), TextYAlignment = Enum.TextYAlignment.Top, Parent = editor })
local edPlace = label({ TextSize = 13, TextColor3 = MUTED, Size = UDim2.new(1, -330, 0, 44), Position = UDim2.fromOffset(330, 86), TextYAlignment = Enum.TextYAlignment.Top, Parent = editor })
local edStats = label({ RichText = true, TextSize = 13, Font = Enum.Font.Code, Size = UDim2.new(1, -330, 0, 200), Position = UDim2.fromOffset(330, 134), TextYAlignment = Enum.TextYAlignment.Top, Parent = editor })
local edError = label({ TextSize = 13, TextColor3 = Color3.fromRGB(255, 120, 140), Size = UDim2.new(1, -330, 0, 18), Position = UDim2.new(0, 330, 1, -70), Parent = editor })

local state = { offers = {}, selected = nil, slot = 0, tilt = 0, open = false }

local function myOrganelles()
	local Net = UI.net
	local info = Net.infos[Net.myId]
	local list = {}
	if info then
		for i, o in info.organelles do
			list[i] = { type = o.type, level = o.level, slot = o.slot, tilt = o.tilt }
		end
	end
	return list
end

local function candidate()
	local orgs = myOrganelles()
	local o = state.offers[state.selected]
	local you = UI.net.you
	local biomass = if you then you.biomass else 10
	local mut = { vitality = 0, metabolism = 0 }
	local ghost = nil
	if o.kind == "new" then
		table.insert(orgs, { type = o.type, level = 1, slot = state.slot, tilt = if Placement.isSurface(o.type) then state.tilt else 0 })
		ghost = #orgs
	elseif o.kind == "upgrade" and orgs[o.index] then
		orgs[o.index].level = o.toLevel
		ghost = o.index
	elseif o.mutation == "growth" then
		biomass += 20
	else
		mut[o.mutation] = 1
	end
	return orgs, ghost, biomass, mut
end

local function fmt(v: number, kind: string): string
	if kind == "pct" then
		return `{math.round(v * 100)}%`
	elseif kind == "deg" then
		return `{math.round(math.deg(v))}°/s`
	end
	return string.format("%.1f", v)
end

local function renderPreview()
	local you = UI.net.you
	if not you or not state.selected then
		return
	end
	local beforeS = Stats.compute(you.biomass, you.level, myOrganelles())
	local orgs, ghost, biomass, mut = candidate()
	local afterS = Stats.compute(biomass, you.level, orgs, mut)
	local function summary(s)
		local function rearSpike()
			local d = Stats.deliveryAt(s, math.pi)
			return if d then d.damage else 0
		end
		local function frontSpike()
			local d = Stats.deliveryAt(s, 0)
			return if d then d.damage else 0
		end
		return {
			{ "Speed forward", s.baseSpeed * Stats.thrustMultiplier(s, 0), "num" },
			{ "Speed sideways", s.baseSpeed * math.max(Stats.thrustMultiplier(s, math.pi / 2), Stats.thrustMultiplier(s, -math.pi / 2)), "num" },
			{ "Turning", s.turnRate, "deg" },
			{ "Max HP", s.maxHp, "num" },
			{ "Energy regen", s.energyRegen, "num" },
			{ "Armor front", 1 - Stats.armorMultiplier(s, 0), "pct" },
			{ "Armor rear", 1 - Stats.armorMultiplier(s, math.pi), "pct" },
			{ "Spike front", frontSpike(), "num" },
			{ "Spike rear", rearSpike(), "num" },
		}
	end
	local a, b = summary(beforeS), summary(afterS)
	local lines = { "<b>                 now     after</b>" }
	for i, row in a do
		local before, after = row[2], b[i][2]
		local color = if math.abs(after - before) < 1e-3 then "#e6fbff" elseif after > before then "#7dffb5" else "#ff8fa3"
		table.insert(lines, `{string.format("%-15s", row[1])}{string.format("%7s", fmt(before, row[3]))}   <font color="{color}">{fmt(after, row[3])}</font>`)
	end
	edStats.Text = table.concat(lines, "\n")

	-- Slot markers and organelle dots on the preview cell.
	for _, c in slotLayer:GetChildren() do
		c:Destroy()
	end
	local c0 = PREVIEW / 2
	local function at(lx: number, ly: number): UDim2
		return UDim2.fromOffset(c0 + lx * R_PREVIEW, c0 + ly * R_PREVIEW)
	end
	for i, o in orgs do
		local lx, ly = Placement.localPos(o)
		local def = Organelles.DEFS[o.type]
		local size = if def.mount == "surface" then 22 else 26
		local dot = make("Frame", { Size = UDim2.fromOffset(size, size), AnchorPoint = Vector2.new(0.5, 0.5), Position = at(lx, ly), BackgroundColor3 = def.color, BorderSizePixel = 0, ZIndex = 3, Parent = slotLayer }, { corner(size // 2) })
		if i == ghost then
			make("UIStroke", { Color = GOLD, Thickness = 3, Parent = dot })
		end
		-- Direction tick for surface organelles (shows tilt).
		if def.mount == "surface" then
			local d = Placement.direction(o)
			make("Frame", { Size = UDim2.fromOffset(4, 4), AnchorPoint = Vector2.new(0.5, 0.5), Position = at(lx + math.cos(d) * 0.28, ly + math.sin(d) * 0.28), BackgroundColor3 = def.color, BorderSizePixel = 0, ZIndex = 3, Parent = slotLayer }, { corner(2) })
		end
		label({ Text = string.sub(def.name, 1, 2), TextXAlignment = Enum.TextXAlignment.Center, Font = Enum.Font.GothamBlack, TextSize = 10, TextColor3 = Color3.fromRGB(10, 20, 24), Size = UDim2.fromScale(1, 1), ZIndex = 4, Parent = dot })
	end
	local o = state.offers[state.selected]
	if o.kind == "new" then
		local valid = Placement.validSlots(myOrganelles(), o.type)
		for _, s in valid do
			local lx, ly = Placement.localPos({ type = o.type, slot = s })
			local b = button({ Text = "", Size = UDim2.fromOffset(16, 16), AnchorPoint = Vector2.new(0.5, 0.5), Position = at(lx * (if Placement.isSurface(o.type) then 1.22 else 1), ly * (if Placement.isSurface(o.type) then 1.22 else 1)), BackgroundColor3 = if s == state.slot then GOLD else ACCENT, BackgroundTransparency = 0.2, ZIndex = 5, Parent = slotLayer }, function()
				state.slot = s
				renderPreview()
			end)
			b:FindFirstChildOfClass("UICorner").CornerRadius = UDim.new(0.5, 0)
		end
		local err = Placement.check(myOrganelles(), o.type, state.slot, if Placement.isSurface(o.type) then state.tilt else 0, if you then you.capacity else 0)
		edError.Text = if err then `Cannot attach here ({err}).` else ""
	else
		edError.Text = ""
	end
end

local tiltLeft = button({ Text = "⟲", Size = UDim2.fromOffset(60, 36), Position = UDim2.fromOffset(30, 0), Parent = tiltRow }, function()
	state.tilt = math.max(-Placement.MAX_TILT, state.tilt - Placement.TILT_STEP)
	tiltText.Text = `Tilt {math.round(math.deg(state.tilt))}°`
	renderPreview()
end)
local tiltRight = button({ Text = "⟳", Size = UDim2.fromOffset(60, 36), Position = UDim2.fromOffset(210, 0), Parent = tiltRow }, function()
	state.tilt = math.min(Placement.MAX_TILT, state.tilt + Placement.TILT_STEP)
	tiltText.Text = `Tilt {math.round(math.deg(state.tilt))}°`
	renderPreview()
end)
local _ = tiltLeft, tiltRight

local function showCards()
	state.selected = nil
	editor.Visible = false
	cardsFrame.Visible = true
	for _, c in cardsFrame:GetChildren() do
		if c:IsA("GuiObject") then
			c:Destroy()
		end
	end
	local width = (860 - 36 - 12 * (#state.offers - 1)) / #state.offers
	for i, o in state.offers do
		local tag, desc, meta = "", "", ""
		if o.kind == "mutation" then
			tag = "MUTATION"
			desc = Progression.MUTATIONS[o.mutation].text
			meta = "Free: uses no capacity."
		else
			local def = Organelles.DEFS[o.type]
			local lvl = if o.kind == "upgrade" then o.toLevel else 1
			tag = (if o.kind == "upgrade" then "UPGRADE · " else "NEW · ") .. string.upper(def.role)
			desc = def.levelText[lvl]
			meta = `{if def.mount == "surface" then "Surface" else "Internal"} · cost {def.slotCost} · weight {math.round(def.weight * 100)}%`
		end
		local card = button({ Text = "", Size = UDim2.new(0, width, 1, 0), BackgroundColor3 = Color3.fromRGB(20, 44, 52), Parent = cardsFrame }, function()
			UI.select(i)
		end)
		if o.kind ~= "mutation" then
			make("Frame", { Size = UDim2.fromOffset(70, 70), Position = UDim2.new(0.5, -35, 0, 16), BackgroundColor3 = Organelles.DEFS[o.type].color, Parent = card }, { corner(35) })
		end
		label({ Text = tag, TextColor3 = ACCENT, Font = Enum.Font.GothamBold, TextSize = 11, Size = UDim2.new(1, -20, 0, 16), Position = UDim2.fromOffset(10, 100), Parent = card })
		label({ Text = Progression.offerTitle(o), Font = Enum.Font.GothamBlack, TextSize = 18, Size = UDim2.new(1, -20, 0, 24), Position = UDim2.fromOffset(10, 118), Parent = card })
		label({ Text = meta, TextColor3 = MUTED, TextSize = 11, Size = UDim2.new(1, -20, 0, 16), Position = UDim2.fromOffset(10, 144), Parent = card })
		label({ Text = desc, TextSize = 14, Size = UDim2.new(1, -20, 0, 120), Position = UDim2.fromOffset(10, 166), TextYAlignment = Enum.TextYAlignment.Top, Parent = card })
	end
end

function UI.select(i: number)
	local o = state.offers[i]
	state.selected = i
	state.tilt = 0
	tiltText.Text = "Tilt 0°"
	cardsFrame.Visible = false
	editor.Visible = true
	edName.Text = Progression.offerTitle(o)
	if o.kind == "mutation" then
		edDesc.Text = Progression.MUTATIONS[o.mutation].text
		edPlace.Text = ""
		tiltRow.Visible = false
	else
		local def = Organelles.DEFS[o.type]
		edDesc.Text = def.levelText[if o.kind == "upgrade" then o.toLevel else 1]
		edPlace.Text = def.placement
		tiltRow.Visible = o.kind == "new" and def.mount == "surface"
		if o.kind == "new" then
			local defaults = { spikes = 0, stinger = 0, membrane = 0, cilia = math.pi, flagellum = math.pi }
			state.slot = Placement.nearestValidSlot(myOrganelles(), o.type, defaults[o.type] or 0, def.mount == "internal") or 0
		end
	end
	renderPreview()
end

button({ Text = "Back", Size = UDim2.fromOffset(110, 40), Position = UDim2.new(1, -250, 1, -46), Parent = editor }, function()
	showCards()
end)
button({ Text = "Confirm", Font = Enum.Font.GothamBlack, BackgroundColor3 = ACCENT, TextColor3 = Color3.fromRGB(3, 42, 38), Size = UDim2.fromOffset(130, 40), Position = UDim2.new(1, -130, 1, -46), Parent = editor }, function()
	local o = state.offers[state.selected]
	if not o then
		return
	end
	local isNew = o.kind == "new"
	UI.callbacks.onEvolveChoose(state.selected, if isNew then state.slot else nil, if isNew and Placement.isSurface(o.type) then state.tilt else 0)
end)

function UI.showEvolution(offers, level: number, pending: number)
	state.offers = offers
	state.open = true
	evoTitle.Text = `Evolution  <font size="14" color="#8fb8c2">Level {level} · {pending} pending</font>`
	evoTitle.RichText = true
	evo.Visible = true
	showCards()
end

function UI.hideEvolution()
	state.open = false
	evo.Visible = false
end

function UI.isEvolutionOpen(): boolean
	return state.open
end

function UI.evolveError(err: string)
	edError.Text = `Rejected by server: {err}`
end

-- ------------------------------------------------------------ death screen
local death = panel({ Size = UDim2.fromOffset(520, 300), Position = UDim2.fromScale(0.5, 0.5), AnchorPoint = Vector2.new(0.5, 0.5), Visible = false, Parent = gui })
label({ Text = "Your cell burst!", Font = Enum.Font.GothamBlack, TextSize = 32, TextColor3 = Color3.fromRGB(255, 93, 122), TextXAlignment = Enum.TextXAlignment.Center, Size = UDim2.new(1, 0, 0, 40), Position = UDim2.fromOffset(0, 18), Parent = death })
local deathBy = label({ TextColor3 = MUTED, TextXAlignment = Enum.TextXAlignment.Center, Size = UDim2.new(1, -20, 0, 20), Position = UDim2.fromOffset(10, 62), Parent = death })
local deathStats = label({ RichText = true, TextSize = 18, TextXAlignment = Enum.TextXAlignment.Center, Size = UDim2.new(1, -20, 0, 110), Position = UDim2.fromOffset(10, 92), Parent = death })
button({ Text = "Play again", Font = Enum.Font.GothamBlack, TextSize = 22, BackgroundColor3 = ACCENT, TextColor3 = Color3.fromRGB(3, 42, 38), Size = UDim2.fromOffset(220, 52), Position = UDim2.new(0.5, -110, 1, -72), Parent = death }, function()
	UI.callbacks.onPlay()
end)

function UI.showDeath(stats)
	local m = math.floor(stats.survivalTime / 60)
	local s = math.floor(stats.survivalTime % 60)
	deathBy.Text = if stats.killedBy then `Consumed by {stats.killedBy}. Peak biomass {stats.peakBiomass}.` else `Peak biomass {stats.peakBiomass}.`
	deathStats.Text = `Survived <b>{m}:{string.format("%02d", s)}</b>   Level <b>{stats.level}</b>\nEliminated <b>{stats.kills}</b>   Biomass collected <b>{stats.biomassCollected}</b>`
	death.Visible = true
	hud.Visible = false
end

-- ------------------------------------------------------------ screens + HUD updates
function UI.setScreen(screen: string)
	menu.Visible = screen == "menu"
	death.Visible = screen == "dead"
	hud.Visible = screen == "playing"
	if screen ~= "playing" then
		UI.hideEvolution()
	end
end

local toastUntil = 0
function UI.toast(text: string, seconds: number?)
	toastText.Text = text
	toastText.TextTransparency = 0
	toastUntil = os.clock() + (seconds or 1.8)
end

function UI.killfeed(text: string)
	table.insert(feedLines, 1, text)
	if #feedLines > 5 then
		table.remove(feedLines)
	end
	feed.Text = table.concat(feedLines, "\n")
	task.delay(5, function()
		local idx = table.find(feedLines, text)
		if idx then
			table.remove(feedLines, idx)
			feed.Text = table.concat(feedLines, "\n")
		end
	end)
end

function UI.setSpectate(text: string?)
	spectateText.Visible = text ~= nil
	spectateText.Text = text or ""
end

local function setBar(fill: Frame, txt: TextLabel, frac: number, text: string)
	fill.Size = UDim2.fromScale(math.clamp(frac, 0, 1), 1)
	txt.Text = text
end

local function setCooldown(key: string, frac: number, enabled: boolean)
	local a = abilityButtons[key]
	a.cd.Size = UDim2.fromScale(1, math.clamp(frac, 0, 1))
	a.button.BackgroundTransparency = if enabled then 0.1 else 0.6
end

function UI.updateHud(you, organelles, leaderboard, myId: number)
	if os.clock() > toastUntil then
		toastText.TextTransparency = 1
	end
	if not you then
		return
	end
	levelText.Text = `Lv {you.level}   <font size="13" color="#8fb8c2">Biomass {math.round(you.biomass)} · {you.kills} kills</font>`
	levelText.RichText = true
	setBar(hpFill, hpText, you.hp / you.maxHp, `{math.min(you.maxHp, math.ceil(you.hp))} / {you.maxHp}`)
	setBar(enFill, enText, you.energy / you.energyMax, `{math.floor(you.energy)} / {you.energyMax} energy`)
	setBar(xpFill, xpText, you.xp / you.xpNext, `{you.xp} / {you.xpNext} XP`)
	capText.Text = `Organelle capacity {you.capacityUsed} / {you.capacity}`
	local chips = {}
	for _, o in organelles do
		local def = Organelles.DEFS[o.type]
		table.insert(chips, `<font color="#{def.color:ToHex()}">●</font> {def.name} {string.rep("I", o.level)}`)
	end
	orgText.Text = table.concat(chips, "   ")
	protectText.Text = if you.protectedFor > 0 then `Protected {string.format("%.1f", you.protectedFor)} s` else ""
	setCooldown("dash", you.dashCd / 2.6, true)
	setCooldown("toxin", you.toxinCd / Organelles.TUNING.toxinCooldown, you.hasToxin)
	setCooldown("venom", you.venomCd / Organelles.TUNING.venomSurgeCooldown, you.hasVenom)
	setCooldown("evolve", 0, you.pendingEvolutions > 0)
	abilityButtons.evolve.button.BackgroundColor3 = if you.pendingEvolutions > 0 then Color3.fromRGB(90, 70, 20) else PANEL

	local lines = {}
	for i, e in leaderboard do
		local line = `{i}. {e.name} ({e.level})  <font color="#8fb8c2">{e.biomass}</font>`
		if e.id == myId then
			line = `<font color="#ffd45e"><b>{line}</b></font>`
		end
		table.insert(lines, line)
	end
	lbText.Text = table.concat(lines, "\n")
	if state.open then
		evoProtect.Text = if you.protectedFor > 0 then `Protected {string.format("%.1f", you.protectedFor)} s` else "Not protected!"
	end
end

function UI.init(net, callbacks)
	UI.net = net
	UI.callbacks = callbacks
	UI.setScreen("menu")
end

return UI
