-- CELL.IO client entry point: camera, input, effects and UI wiring.
local RunService = game:GetService("RunService")
local UserInputService = game:GetService("UserInputService")
local Workspace = game:GetService("Workspace")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local Config = require(Shared.Config)
local MathUtil = require(Shared.MathUtil)

local Net = require(script.Net)
local Renderer = require(script.Renderer)
local UI = require(script.UI)

local S = Config.STUDS_PER_UNIT
local camera = Workspace.CurrentCamera

local screen = "menu"
local focus = { x = Config.WORLD_SIZE / 2, y = Config.WORLD_SIZE / 2, r = 22 }
local camPos = Vector3.new(focus.x * S, 0, focus.y * S)
local camHeight = Config.cameraHeight(22)
local spectateId: number? = nil
local dismissedEvolution = false
local lastQueuedToast = 0

local function setScreen(s: string)
	screen = s
	UI.setScreen(s)
end

UI.init(Net, {
	onPlay = function()
		Net.R.Play:FireServer()
		spectateId = nil
		UI.setSpectate(nil)
		setScreen("playing")
	end,
	onAbility = function(key: string)
		if screen == "playing" and not UI.isEvolutionOpen() then
			Net.R.Ability:FireServer(key)
		end
	end,
	onEvolveOpen = function()
		local you = Net.you
		if screen ~= "playing" or not you or you.pendingEvolutions <= 0 then
			return
		end
		if you.combatLock > 0 then
			UI.toast("Evolution queued\n<font size=\"16\">Get out of combat to evolve</font>", 1.2)
			return
		end
		dismissedEvolution = false
		Net.R.EvolveOpen:FireServer()
	end,
	onEvolveClose = function()
		dismissedEvolution = true
		Net.R.EvolveClose:FireServer()
	end,
	onEvolveChoose = function(index: number, slot: number?, tilt: number)
		Net.R.EvolveChoose:FireServer(index, slot, tilt)
	end,
})

Net.onWelcome = function()
	Renderer.buildWorld(Net.hazards)
end

Net.onOffer = function(o)
	if screen == "playing" then
		local you = Net.you
		UI.showEvolution(o.offers, if you then you.level else 1, if you then you.pendingEvolutions else 1)
	end
end

Net.onEvolveResult = function(ok: boolean, err: string?)
	if ok then
		UI.hideEvolution() -- the server sends a new offer if more are pending
		UI.toast("Organelle attached!", 1)
	else
		UI.evolveError(err or "rejected")
	end
end

Net.onDied = function(stats)
	UI.hideEvolution()
	if stats.killerId then
		spectateId = stats.killerId
		UI.setSpectate(`Killed by {stats.killedBy}`)
	end
	task.delay(if stats.killerId then 3 else 0.9, function()
		UI.setSpectate(nil)
		if screen == "playing" then
			setScreen("dead")
			UI.showDeath(stats)
		end
	end)
end

Net.onNutrientsRemoved = function(ids)
	Renderer.removeNutrients(ids)
end

local HIT_COLORS = {
	spike = Color3.new(1, 1, 1),
	sting = Color3.fromRGB(208, 139, 255),
	bump = Color3.fromRGB(184, 212, 220),
	dot = Color3.fromRGB(157, 255, 61),
	toxin = Color3.fromRGB(198, 255, 61),
	acid = Color3.fromRGB(198, 255, 61),
}
local VERBS = { spike = "spiked", sting = "stung", dot = "poisoned", toxin = "gassed", bump = "rammed", acid = "dissolved" }

Net.onEvents = function(events)
	for _, ev in events do
		if ev.e == "hit" then
			Renderer.burst(ev.x, ev.y, if ev.kind == "dot" then 3 else 4 + ev.amount, HIT_COLORS[ev.kind] or Color3.new(1, 1, 1))
			if ev.amount >= 1 then
				local mine = ev.target == Net.myId
				local byMe = ev.source == Net.myId and ev.source ~= 0
				local color = if mine then Color3.fromRGB(255, 107, 129) elseif byMe then Color3.fromRGB(255, 241, 168) else Color3.fromRGB(216, 232, 236)
				Renderer.damageNumber(ev.x, ev.y, ev.amount, color, mine or byMe)
			end
		elseif ev.e == "death" then
			Renderer.burst(ev.x, ev.y, 50, Color3.fromHSV(ev.hue % 1, 0.6, 1))
			Renderer.destroyView(ev.id)
		elseif ev.e == "eat" then
			Renderer.eatNutrient(ev.nutrient, ev.id)
		elseif ev.e == "level" and ev.id == Net.myId then
			UI.toast(`Level {ev.level}!\n<font size="16">New evolution available</font>`)
			dismissedEvolution = false
		elseif ev.e == "toxin" then
			Renderer.burst(ev.x, ev.y, 40, Color3.fromRGB(198, 255, 61))
		elseif ev.e == "break" then
			Renderer.burst(ev.x, ev.y, 22, Color3.fromRGB(255, 241, 214))
			if ev.id == Net.myId then
				UI.toast(`Your {ev.type} broke!\n<font size="16">It regrows in 12 s</font>`, 1.5)
			end
		elseif ev.e == "kill" then
			UI.killfeed(`{ev.killer} {VERBS[ev.how] or "killed"} {ev.victim}`)
		end
	end
end

-- ------------------------------------------------------------ input
-- Steering target in screen pixels: a held finger, else the mouse.
local activeTouch: Vector2? = nil
local function steerTarget(): Vector2?
	if activeTouch then
		return activeTouch
	end
	if UserInputService.MouseEnabled then
		return UserInputService:GetMouseLocation()
	end
	return nil
end
UserInputService.TouchStarted:Connect(function(input, processed)
	if not processed then
		activeTouch = Vector2.new(input.Position.X, input.Position.Y)
	end
end)
UserInputService.TouchMoved:Connect(function(input)
	if activeTouch then
		activeTouch = Vector2.new(input.Position.X, input.Position.Y)
	end
end)
UserInputService.TouchEnded:Connect(function()
	activeTouch = nil
end)

UserInputService.InputBegan:Connect(function(input, processed)
	if processed or screen ~= "playing" then
		return
	end
	local k = input.KeyCode
	if k == Enum.KeyCode.Space then
		UI.callbacks.onAbility("dash")
	elseif k == Enum.KeyCode.Q then
		local you = Net.you
		UI.callbacks.onAbility(if you and not you.hasToxin and you.hasVenom then "venom" else "toxin")
	elseif k == Enum.KeyCode.R then
		UI.callbacks.onAbility("venom")
	elseif k == Enum.KeyCode.E then
		UI.callbacks.onEvolveOpen()
	end
end)

local lastInput = 0
local function sendInput(now: number)
	if now - lastInput < 0.05 or not Net.you then
		return
	end
	lastInput = now
	local target = steerTarget()
	if UI.isEvolutionOpen() or not target then
		Net.R.Input:FireServer(0, 0)
		return
	end
	-- Project the pointer onto the arena floor (y = 0).
	local ray = camera:ViewportPointToRay(target.X, target.Y)
	if math.abs(ray.Direction.Y) < 1e-4 then
		return
	end
	local dist = -ray.Origin.Y / ray.Direction.Y
	local hit = ray.Origin + ray.Direction * dist
	local wx, wy = hit.X / S, hit.Z / S
	local dx, dy = wx - focus.x, wy - focus.y
	-- Throttle by on-screen distance from the cell.
	local cellScreen = camera:WorldToViewportPoint(Vector3.new(focus.x * S, 0, focus.y * S))
	local screenDist = (Vector2.new(cellScreen.X, cellScreen.Y) - target).Magnitude
	local viewport = camera.ViewportSize
	local dead = 12
	local throttle = math.clamp((screenDist - dead) / (math.min(viewport.X, viewport.Y) * 0.22), 0, 1)
	Net.R.Input:FireServer(math.atan2(dy, dx), throttle)
end

-- ------------------------------------------------------------ frame
camera.CameraType = Enum.CameraType.Scriptable
camera.FieldOfView = 70

local hudTimer = 0
RunService.RenderStepped:Connect(function(dt)
	local now = os.clock()
	local cells = Net.sample()
	local me = cells[Net.myId]
	if me and Net.you then
		focus = { x = me.x, y = me.y, r = me.radius }
	elseif spectateId and cells[spectateId] then
		local k = cells[spectateId]
		focus = { x = k.x, y = k.y, r = math.max(30, k.radius) }
	end
	Renderer.frame(cells, Net.infos, Net.nutrients, Net.clouds, Net.myId, now)

	-- Camera: smooth follow, height grows with the cell.
	local target = Vector3.new(focus.x * S, 0, focus.y * S)
	if (target - camPos).Magnitude > 80 then
		camPos = target
	end
	camPos = camPos:Lerp(target, 1 - math.exp(-dt * 10))
	camHeight = MathUtil.lerp(camHeight, Config.cameraHeight(focus.r), 1 - math.exp(-dt * 2.5))
	camera.CFrame = CFrame.lookAt(camPos + Vector3.new(0, camHeight, 0), camPos, Vector3.new(0, 0, -1))

	if screen == "playing" then
		sendInput(now)
		hudTimer += dt
		if hudTimer > 0.1 then
			hudTimer = 0
			local info = Net.infos[Net.myId]
			UI.updateHud(Net.you, if info then info.organelles else {}, Net.leaderboard, Net.myId)
			-- Auto-open evolution when available and out of combat.
			local you = Net.you
			if you and you.pendingEvolutions > 0 and not UI.isEvolutionOpen() and not dismissedEvolution then
				if you.combatLock > 0 then
					if now - lastQueuedToast > 2.5 then
						lastQueuedToast = now
						UI.toast("Evolution queued\n<font size=\"16\">Get out of combat to evolve</font>", 1.2)
					end
				elseif now - lastQueuedToast > 1.5 then
					lastQueuedToast = now
					Net.R.EvolveOpen:FireServer()
				end
			end
		end
	end
end)
