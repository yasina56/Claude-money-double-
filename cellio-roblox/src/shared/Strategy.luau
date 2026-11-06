-- Reads a cell's evolutionary strategy from its layout (placement counts).
local MathUtil = require(script.Parent.MathUtil)
local Placement = require(script.Parent.Placement)

local Strategy = {}

Strategy.COLORS = {
	Hunter = Color3.fromRGB(255, 122, 122),
	Tank = Color3.fromRGB(143, 180, 255),
	Speedster = Color3.fromRGB(255, 224, 102),
	Toxic = Color3.fromRGB(198, 255, 61),
	Hybrid = Color3.fromRGB(217, 194, 255),
}

local function facing(o, target: number, tol: number): boolean
	return math.abs(MathUtil.angleDiff(Placement.direction(o), target)) <= tol
end

function Strategy.classify(organelles): string?
	if #organelles == 0 then
		return nil
	end
	local s = { Hunter = 0, Tank = 0, Speedster = 0, Toxic = 0 }
	for _, o in organelles do
		local w = 1 + 0.25 * (o.level - 1)
		local t = o.type
		if t == "spikes" then
			if facing(o, 0, math.pi / 3) then
				s.Hunter += 2 * w
			elseif facing(o, math.pi, math.pi / 3) then
				s.Tank += 0.8 * w
			else
				s.Hunter += 0.8 * w
			end
		elseif t == "stinger" then
			s.Hunter += w
			s.Toxic += 0.6 * w
		elseif t == "venom" then
			s.Hunter += w
			s.Toxic += 1.2 * w
		elseif t == "membrane" then
			s.Tank += 2 * w
		elseif t == "regen" then
			s.Tank += 1.5 * w
			s.Toxic += 0.5 * w
		elseif t == "mitochondria" then
			s.Tank += 0.4 * w
			s.Speedster += 0.5 * w
		elseif t == "cilia" then
			s.Speedster += w
		elseif t == "flagellum" then
			if math.abs(MathUtil.angleDiff(Placement.angle(o) + o.tilt, math.pi)) <= math.pi / 3 then
				s.Speedster += 2 * w
				s.Hunter += 0.6 * w
			else
				s.Speedster += 0.8 * w
			end
		elseif t == "toxin" then
			s.Toxic += 2.5 * w
		end
	end
	local ranked = {}
	for k, v in s do
		table.insert(ranked, { k, v })
	end
	table.sort(ranked, function(p, q)
		return p[2] > q[2]
	end)
	local top, second = ranked[1], ranked[2]
	if top[2] < 1.5 then
		return nil
	end
	if second[2] > 0 and top[2] < second[2] * 1.35 then
		return "Hybrid"
	end
	return top[1]
end

return Strategy
