-- Derives a cell's stat block from biomass, level, mutations and the
-- PLACEMENT of its organelles: thrust, armor arcs, hit arcs, venom links and
-- toxin emitters are all directional. Port of cell-io/shared/stats.ts.
local Config = require(script.Parent.Config)
local MathUtil = require(script.Parent.MathUtil)
local Organelles = require(script.Parent.Organelles)
local Placement = require(script.Parent.Placement)

local T = Organelles.TUNING
local softCap = MathUtil.softCap

local Stats = {}

function Stats.compute(biomass: number, level: number, organelles, mutations, disabled)
	mutations = mutations or { vitality = 0, metabolism = 0 }
	local radius = Config.radiusFromBiomass(biomass)
	local sizeRel = radius / 22

	local weight, upkeep = 0, 0
	local energyMax = 100 + mutations.metabolism * 15
	local mitoRegen, turnBonus, turnPenalty, accelBonus, resistance, bonusHp, regenFrac = 0, 0, 0, 0, 0, 0, 0
	local thrust, deliveries, armor, toxins, sacs = {}, {}, {}, {}, {}
	local centerMito, regenCentered, mitoCount = false, false, 0

	for index, o in organelles do
		if disabled and disabled[index] then
			continue
		end
		local def = Organelles.DEFS[o.type]
		local lv = math.clamp(o.level, 1, 3)
		weight += def.weight
		upkeep += def.upkeep
		local at = Placement.angle(o)
		local dir = Placement.direction(o)
		if o.type == "cilia" then
			local eff = T.ciliaEff[lv]
			table.insert(thrust, { dir = dir + math.pi, amount = eff, focus = 1, isotropic = 0.35 })
			turnBonus += eff * (0.3 + 0.6 * math.abs(math.sin(at)))
			accelBonus += eff * 0.8
		elseif o.type == "flagellum" then
			table.insert(thrust, { dir = dir + math.pi, amount = T.flagThrust[lv], focus = 3, isotropic = 0 })
			turnPenalty += T.flagTurnPenalty[lv]
		elseif o.type == "spikes" then
			table.insert(deliveries, { kind = "spikes", index = index, dir = dir, arc = T.spikeArc, damage = T.spikeDmg[lv], bleed = lv >= 3 })
		elseif o.type == "stinger" then
			table.insert(deliveries, { kind = "stinger", index = index, dir = dir, arc = T.stingerArc[lv], damage = T.stingerDmg[lv], bleed = false })
		elseif o.type == "membrane" then
			table.insert(armor, { index = index, dir = at, halfArc = T.membraneHalfArc, reduction = T.membraneReduction[lv] })
			resistance += 0.03
			bonusHp += 12 + 8 * (lv - 1)
		elseif o.type == "mitochondria" then
			mitoRegen += T.mitoRegen[lv]
			energyMax += T.mitoEnergy[lv]
			mitoCount += 1
			if o.slot == 0 then
				centerMito = true
			end
		elseif o.type == "venom" then
			table.insert(sacs, { angle = at, centered = Placement.internal(o.slot).r == 0, level = lv })
		elseif o.type == "regen" then
			regenFrac += T.regenFrac[lv] * (if o.slot == 0 then 1.25 else 1)
			if o.slot == 0 then
				regenCentered = true
			end
		elseif o.type == "toxin" then
			local s = Placement.internal(o.slot)
			table.insert(toxins, { dir = at, offset = if s.r == 0 then 0 else 1.15, radius = T.toxinRadius[lv], dps = T.toxinDps[lv] })
		end
	end

	-- Venom sacs link to delivery organelles on the same side.
	for _, d in deliveries do
		local best = nil
		for _, sac in sacs do
			local potency = 0
			if sac.centered then
				potency = 0.6
			elseif math.abs(MathUtil.angleDiff(sac.angle, d.dir)) <= T.venomLinkArc then
				potency = 1
			end
			if d.kind == "spikes" then
				potency *= 0.6
			end
			if potency > 0 then
				local v = { dps = T.venomDps[sac.level] * potency, slow = T.venomSlow[sac.level], potency = potency }
				if not best or v.dps > best.dps then
					best = v
				end
			end
		end
		d.venom = best
	end

	if centerMito or (regenCentered and mitoCount > 0) then
		regenFrac *= 1.15
	end

	local weightMult = 1 - softCap(weight, 0.35)
	local baseHp = 80 + biomass * 1.2 + bonusHp
	local maxHp = baseHp * (1 + 0.1 * mutations.vitality)
	if level >= Config.APEX_LEVEL then
		maxHp *= 1.15
	end

	return {
		radius = radius,
		maxHp = maxHp,
		baseSpeed = 235 * sizeRel ^ -0.45 * weightMult,
		accel = 650 * sizeRel ^ -0.55 * (1 + softCap(accelBonus, 0.6)) * weightMult,
		turnRate = 5.2 * sizeRel ^ -0.35 * (1 + softCap(turnBonus, 0.9)) * (1 - softCap(turnPenalty, 0.5)),
		weightMult = weightMult,
		energyMax = energyMax,
		energyRegen = math.max(1, 5 + softCap(mitoRegen, 16) - upkeep),
		resistance = softCap(resistance, 0.25),
		regenFrac = regenFrac,
		thrust = thrust,
		deliveries = deliveries,
		armor = armor,
		toxins = toxins,
		sizeFactor = math.min(2.6, sizeRel ^ 0.55),
		mass = biomass * (1 + weight),
	}
end

-- Speed multiplier for moving at localAngle (0 = straight ahead), soft-capped at +80%.
function Stats.thrustMultiplier(stats, localAngle: number): number
	local sum = 0
	for _, t in stats.thrust do
		local c = math.max(0, math.cos(localAngle - t.dir))
		sum += t.amount * (t.isotropic + (1 - t.isotropic) * c ^ t.focus)
	end
	return 1 + softCap(sum, 0.8)
end

-- Damage multiplier (0..1) for a hit arriving at localAngle.
function Stats.armorMultiplier(stats, localAngle: number): number
	local red = 0
	for _, a in stats.armor do
		if math.abs(MathUtil.angleDiff(a.dir, localAngle)) <= a.halfArc then
			red = math.max(red, a.reduction)
		end
	end
	return (1 - red) * (1 - stats.resistance)
end

-- Strongest spike/stinger whose arc contains localAngle.
function Stats.deliveryAt(stats, localAngle: number)
	local best = nil
	for _, d in stats.deliveries do
		if math.abs(MathUtil.angleDiff(d.dir, localAngle)) <= d.arc and (not best or d.damage > best.damage) then
			best = d
		end
	end
	return best
end

-- Net propulsion vector (local frame) from cilia/flagellum layout.
function Stats.propulsion(stats): (number, number, number)
	local x, y = 0, 0
	for _, t in stats.thrust do
		local w = t.amount * (1 - t.isotropic)
		x += math.cos(t.dir) * w
		y += math.sin(t.dir) * w
	end
	return x, y, math.sqrt(x * x + y * y)
end

return Stats
