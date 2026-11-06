-- Client networking state: snapshot buffer + interpolation, cell infos,
-- nutrient deltas, private state. Server time comes in every snapshot.
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("Shared")
local MathUtil = require(Shared.MathUtil)

local Net = {}

local remotes = ReplicatedStorage:WaitForChild("Remotes")
Net.R = {}
for _, r in remotes:GetChildren() do
	Net.R[r.Name] = r
end

Net.myId = 0
Net.worldSize = 4800
Net.hazards = {}
Net.you = nil
Net.infos = {} -- id -> info
Net.nutrients = {} -- id -> { id, x, y, kind }
Net.clouds = {}
Net.leaderboard = {}
Net.latest = {} -- id -> cell record of the newest snapshot

local buffer = {} -- { t, cells = { [id] = rec } }
local offset: number? = nil -- server time - local clock
local INTERP_DELAY = 0.12

-- Callbacks set by other modules.
Net.onEvents = function(_events) end
Net.onOffer = function(_offer) end
Net.onEvolveResult = function(_ok, _err) end
Net.onDied = function(_stats) end
Net.onWelcome = function() end
Net.onNutrientsRemoved = function(_ids) end

local function unpackCell(a)
	return { id = a[1], x = a[2], y = a[3], heading = a[4], radius = a[5], hp = a[6], flags = a[7], vx = a[8], vy = a[9] }
end

Net.R.Welcome.OnClientEvent:Connect(function(w)
	Net.myId = w.id
	Net.worldSize = w.worldSize
	Net.hazards = w.hazards
	buffer = {}
	Net.onWelcome()
end)

Net.R.Snapshot.OnClientEvent:Connect(function(s)
	local now = os.clock()
	local off = s.t - now
	if offset == nil or math.abs(off - offset) > 0.5 then
		offset = off
	else
		offset += (off - offset) * 0.08
	end
	local cells = {}
	for _, a in s.cells do
		local rec = unpackCell(a)
		cells[rec.id] = rec
	end
	table.insert(buffer, { t = s.t, cells = cells })
	if #buffer > 30 then
		table.remove(buffer, 1)
	end
	Net.latest = cells
	for _, info in s.infos do
		Net.infos[info.id] = info
	end
	Net.you = s.you
	local clouds = {}
	for _, c in s.clouds do
		table.insert(clouds, { id = c[1], x = c[2], y = c[3], r = c[4], life = c[5] })
	end
	Net.clouds = clouds

	if s.nAdd then
		local removed = {}
		if s.nFull then
			for id in Net.nutrients do
				table.insert(removed, id)
			end
			Net.nutrients = {}
		end
		for _, n in s.nAdd do
			Net.nutrients[n[1]] = { id = n[1], x = n[2], y = n[3], kind = n[4] }
		end
		for _, id in s.nDel do
			if Net.nutrients[id] then
				Net.nutrients[id] = nil
				table.insert(removed, id)
			end
		end
		if #removed > 0 then
			Net.onNutrientsRemoved(removed)
		end
	end
end)

Net.R.Events.OnClientEvent:Connect(function(events)
	Net.onEvents(events)
end)
Net.R.Leaderboard.OnClientEvent:Connect(function(l)
	Net.leaderboard = l
end)
Net.R.Offer.OnClientEvent:Connect(function(o)
	Net.onOffer(o)
end)
Net.R.EvolveResult.OnClientEvent:Connect(function(ok, err)
	Net.onEvolveResult(ok, err)
end)
Net.R.Died.OnClientEvent:Connect(function(stats)
	Net.you = nil
	Net.onDied(stats)
end)

-- Cells interpolated at render time (server time - INTERP_DELAY).
function Net.sample()
	local out = {}
	if #buffer == 0 or offset == nil then
		return out
	end
	local rt = os.clock() + offset - INTERP_DELAY
	local older, newer = buffer[1], buffer[#buffer]
	for i = #buffer, 2, -1 do
		if buffer[i - 1].t <= rt then
			older, newer = buffer[i - 1], buffer[i]
			break
		end
	end
	local span = newer.t - older.t
	local f = if span > 0 then math.clamp((rt - older.t) / span, 0, 1.2) else 1
	for id, n in newer.cells do
		local o = older.cells[id]
		if o then
			out[id] = {
				id = id,
				x = MathUtil.lerp(o.x, n.x, f),
				y = MathUtil.lerp(o.y, n.y, f),
				heading = MathUtil.lerpAngle(o.heading, n.heading, math.min(1, f)),
				radius = MathUtil.lerp(o.radius, n.radius, math.min(1, f)),
				hp = n.hp,
				flags = n.flags,
				vx = n.vx,
				vy = n.vy,
			}
		else
			out[id] = n
		end
	end
	return out
end

return Net
