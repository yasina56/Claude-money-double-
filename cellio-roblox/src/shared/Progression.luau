-- Levels, XP curve and evolution offers (same rules as the web version).
--  L2 first organelles, L3 more capacity, L4 tier 2, L5 upgrades to II,
--  L7 tier 3, L10 four choices, L15 upgrades to III, L20 apex.
local Organelles = require(script.Parent.Organelles)
local Placement = require(script.Parent.Placement)

local Progression = {}

function Progression.xpToNext(level: number): number
	return math.round(30 + 16 * (level - 1) ^ 1.4)
end

function Progression.maxOrganelleLevel(level: number): number
	if level >= 15 then
		return 3
	elseif level >= 5 then
		return 2
	end
	return 1
end

function Progression.offerCount(level: number): number
	return if level >= 10 then 4 else 3
end

Progression.MUTATIONS = {
	vitality = { name = "Vitality Mutation", text = "+10% max HP" },
	metabolism = { name = "Metabolic Mutation", text = "+15 max energy" },
	growth = { name = "Growth Spurt", text = "+20 biomass instantly" },
}

local function shuffle(arr, rng: Random)
	for i = #arr, 2, -1 do
		local j = rng:NextInteger(1, i)
		arr[i], arr[j] = arr[j], arr[i]
	end
	return arr
end

-- Offers: { kind = "new", type } | { kind = "upgrade", type, index, toLevel } | { kind = "mutation", mutation }
-- `index` is the 1-based position in the organelle list.
function Progression.generateOffers(level: number, organelles, rng: Random)
	local free = Placement.capacityForLevel(level) - Placement.capacityUsed(organelles)
	local maxLvl = Progression.maxOrganelleLevel(level)
	local news, upgrades = {}, {}
	for _, t in Organelles.TYPES do
		local def = Organelles.DEFS[t]
		if def.unlockLevel <= level and def.slotCost <= free and #Placement.validSlots(organelles, t) > 0 then
			table.insert(news, { kind = "new", type = t })
		end
	end
	for i, o in organelles do
		if o.level < maxLvl then
			table.insert(upgrades, { kind = "upgrade", type = o.type, index = i, toLevel = o.level + 1 })
		end
	end
	shuffle(news, rng)
	shuffle(upgrades, rng)
	local want = Progression.offerCount(level)
	local out = {}
	if #news > 0 then
		table.insert(out, table.remove(news, 1))
	end
	if #upgrades > 0 then
		table.insert(out, table.remove(upgrades, 1))
	end
	local pool = {}
	for _, x in news do
		table.insert(pool, x)
	end
	for _, x in upgrades do
		table.insert(pool, x)
	end
	shuffle(pool, rng)
	while #out < want and #pool > 0 do
		local nxt = table.remove(pool, 1)
		local dup = false
		for _, o in out do
			if o.kind == nxt.kind and ((o.kind == "new" and o.type == nxt.type) or (o.kind == "upgrade" and o.index == nxt.index)) then
				dup = true
			end
		end
		if not dup then
			table.insert(out, nxt)
		end
	end
	local muts = shuffle({ "vitality", "metabolism", "growth" }, rng)
	while #out < want do
		table.insert(out, { kind = "mutation", mutation = table.remove(muts, 1) })
	end
	return out
end

function Progression.offerTitle(o): string
	if o.kind == "mutation" then
		return Progression.MUTATIONS[o.mutation].name
	end
	local def = Organelles.DEFS[o.type]
	if o.kind == "upgrade" then
		return `{def.levelNames[o.toLevel]} (Lv{o.toLevel})`
	end
	return def.levelNames[1]
end

return Progression
