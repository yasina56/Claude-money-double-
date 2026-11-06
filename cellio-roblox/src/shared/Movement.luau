-- Movement + dash, shared by the server simulation and (optionally) client
-- prediction. Port of cell-io/shared/sim/movement.ts.
local Config = require(script.Parent.Config)
local MathUtil = require(script.Parent.MathUtil)
local Stats = require(script.Parent.Stats)

local Movement = {}

local function sanitize(a: any, t: any): (number, number)
	a = if MathUtil.isFiniteNumber(a) then a else 0
	t = if MathUtil.isFiniteNumber(t) then MathUtil.clamp(t, 0, 1) else 0
	return a, t
end
Movement.sanitize = sanitize

-- body: { x, y, vx, vy, heading }; input: { a, t }; mods: { slow, evolving }
function Movement.integrate(body, stats, input, mods, hazards, dt: number)
	local a, t = sanitize(input.a, input.t)
	local localA = MathUtil.angleDiff(body.heading, a)
	local facing = 0.7 + 0.3 * math.max(0, math.cos(localA))
	local speedMult = Stats.thrustMultiplier(stats, localA) * facing
	if mods.slow > 0 then
		speedMult *= 1 - mods.slow
	end
	if mods.evolving then
		speedMult *= Config.EVOLVE_SLOW
	end
	local target = stats.baseSpeed * speedMult * t
	local dvx = math.cos(a) * target - body.vx
	local dvy = math.sin(a) * target - body.vy
	local dv = math.sqrt(dvx * dvx + dvy * dvy)
	local maxDv = stats.accel * dt
	if dv > maxDv then
		dvx *= maxDv / dv
		dvy *= maxDv / dv
	end
	body.vx += dvx
	body.vy += dvy

	local px, py = 0, 0
	for _, h in hazards do
		if h.kind == "current" then
			local d = math.sqrt((body.x - h.x) ^ 2 + (body.y - h.y) ^ 2)
			local reach = h.r + stats.radius * 0.5
			if d <= reach then
				local strength = h.strength * (1 - d / reach) * (22 / stats.radius) ^ 0.3
				px += math.cos(h.dir) * strength
				py += math.sin(h.dir) * strength
			end
		end
	end

	local lo = stats.radius * 0.5
	local hi = Config.WORLD_SIZE - stats.radius * 0.5
	body.x = MathUtil.clamp(body.x + (body.vx + px) * dt, lo, hi)
	body.y = MathUtil.clamp(body.y + (body.vy + py) * dt, lo, hi)
	if body.x <= lo or body.x >= hi then
		body.vx *= -0.3
	end
	if body.y <= lo or body.y >= hi then
		body.vy *= -0.3
	end

	if t > 0.05 then
		local maxTurn = stats.turnRate * dt
		body.heading = MathUtil.wrapAngle(body.heading + MathUtil.clamp(MathUtil.angleDiff(body.heading, a), -maxTurn, maxTurn))
	end
end

-- Dash fires along the net propulsion layout; even layouts follow steering.
function Movement.dashImpulse(body, stats, input, level: number): (number, number)
	local a, t = sanitize(input.a, input.t)
	local px, py, mag = Stats.propulsion(stats)
	local dir, boost
	if mag >= 0.1 then
		dir = body.heading + math.atan2(py, px)
		boost = 1 + 0.5 * math.min(1, mag / 0.5)
	else
		dir = if t > 0.05 then a else body.heading
		boost = 1
	end
	local impulse = Config.DASH_IMPULSE * boost * (if level >= Config.APEX_LEVEL then 1.25 else 1) * stats.weightMult * (22 / stats.radius) ^ 0.2
	return math.cos(dir) * impulse, math.sin(dir) * impulse
end

return Movement
