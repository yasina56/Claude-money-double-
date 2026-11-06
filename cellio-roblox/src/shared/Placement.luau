-- Normalized attachment system. Surface organelles sit on one of 16 snap
-- angles (slot 0 = the cell's front, angles grow clockwise seen from above);
-- internal organelles use one of 7 slots (center + a ring at half radius).
-- Slot numbers are 0-based, exactly like the web version.
local Organelles = require(script.Parent.Organelles)
local MathUtil = require(script.Parent.MathUtil)

local Placement = {}

Placement.SURFACE_SLOTS = 16
Placement.MAX_TILT = math.pi / 4
Placement.TILT_STEP = math.pi / 12

Placement.INTERNAL_SLOTS = { { r = 0, a = 0 } }
for k = 0, 5 do
	table.insert(Placement.INTERNAL_SLOTS, { r = 0.5, a = k * MathUtil.TAU / 6 })
end

local function internal(slot: number)
	return Placement.INTERNAL_SLOTS[slot + 1]
end
Placement.internal = internal

function Placement.surfaceSlotAngle(slot: number): number
	return slot * MathUtil.TAU / Placement.SURFACE_SLOTS
end

function Placement.isSurface(t: string): boolean
	return Organelles.DEFS[t].mount == "surface"
end

-- Local angle (relative to heading) of an organelle's attachment point.
function Placement.angle(o): number
	if Placement.isSurface(o.type) then
		return Placement.surfaceSlotAngle(o.slot)
	end
	return internal(o.slot).a
end

-- Local direction an organelle points (attachment angle + tilt).
function Placement.direction(o): number
	return Placement.angle(o) + (if Placement.isSurface(o.type) then o.tilt else 0)
end

function Placement.localPos(o): (number, number)
	if Placement.isSurface(o.type) then
		local a = Placement.surfaceSlotAngle(o.slot)
		return math.cos(a), math.sin(a)
	end
	local s = internal(o.slot)
	return math.cos(s.a) * s.r, math.sin(s.a) * s.r
end

function Placement.snapsFor(slot: number, span: number): { number }
	local half = math.floor(span / 2)
	local out = {}
	for k = -half, half do
		table.insert(out, (slot + k) % Placement.SURFACE_SLOTS)
	end
	return out
end

function Placement.capacityUsed(organelles): number
	local sum = 0
	for _, o in organelles do
		sum += Organelles.DEFS[o.type].slotCost
	end
	return sum
end

function Placement.capacityForLevel(level: number): number
	local tbl = { 0, 0, 2, 3, 4, 4, 5, 6, 6, 7, 8 } -- index = level + 1
	if level < #tbl then
		return tbl[level + 1]
	end
	return math.min(13, 8 + math.floor((level - 10) / 2))
end

-- Returns nil when valid, else an error code: "mount" | "range" | "occupied" | "tilt" | "capacity".
function Placement.check(organelles, t: string, slot: any, tilt: any, capacity: number): string?
	local def = Organelles.DEFS[t]
	if not def then
		return "mount"
	end
	if typeof(slot) ~= "number" or slot ~= math.floor(slot) or not MathUtil.isFiniteNumber(tilt) then
		return "range"
	end
	if Placement.capacityUsed(organelles) + def.slotCost > capacity then
		return "capacity"
	end
	if def.mount == "surface" then
		if slot < 0 or slot >= Placement.SURFACE_SLOTS then
			return "range"
		end
		if math.abs(tilt) > Placement.MAX_TILT + 1e-6 then
			return "tilt"
		end
		local occupied = {}
		for _, o in organelles do
			local d = Organelles.DEFS[o.type]
			if d.mount == "surface" then
				for _, s in Placement.snapsFor(o.slot, d.span) do
					occupied[s] = true
				end
			end
		end
		for _, s in Placement.snapsFor(slot, def.span) do
			if occupied[s] then
				return "occupied"
			end
		end
	else
		if slot < 0 or slot >= #Placement.INTERNAL_SLOTS then
			return "range"
		end
		if tilt ~= 0 then
			return "tilt"
		end
		for _, o in organelles do
			if Organelles.DEFS[o.type].mount == "internal" and o.slot == slot then
				return "occupied"
			end
		end
	end
	return nil
end

function Placement.validSlots(organelles, t: string): { number }
	local n = if Placement.isSurface(t) then Placement.SURFACE_SLOTS else #Placement.INTERNAL_SLOTS
	local out = {}
	for s = 0, n - 1 do
		if Placement.check(organelles, t, s, 0, math.huge) == nil then
			table.insert(out, s)
		end
	end
	return out
end

-- Valid slot closest to a preferred local angle (AI and default placement).
function Placement.nearestValidSlot(organelles, t: string, localAngle: number, preferCenter: boolean?): number?
	local slots = Placement.validSlots(organelles, t)
	if #slots == 0 then
		return nil
	end
	local surface = Placement.isSurface(t)
	if preferCenter and not surface and table.find(slots, 0) then
		return 0
	end
	local best, bestD = slots[1], math.huge
	for _, s in slots do
		local d
		if not surface and s == 0 then
			d = math.pi * 0.9
		else
			d = math.abs(MathUtil.angleDiff(Placement.angle({ type = t, slot = s }), localAngle))
		end
		if d < bestD then
			best, bestD = s, d
		end
	end
	return best
end

return Placement
