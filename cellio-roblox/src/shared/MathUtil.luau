-- Small math helpers shared by server and client.
local MathUtil = {}

MathUtil.TAU = math.pi * 2

function MathUtil.clamp(v: number, lo: number, hi: number): number
	if v < lo then
		return lo
	elseif v > hi then
		return hi
	end
	return v
end

function MathUtil.lerp(a: number, b: number, t: number): number
	return a + (b - a) * t
end

-- Wrap an angle to (-pi, pi].
function MathUtil.wrapAngle(a: number): number
	a = a % MathUtil.TAU -- Luau % is floored, result in [0, TAU)
	if a > math.pi then
		a -= MathUtil.TAU
	end
	return a
end

-- Signed shortest difference b - a.
function MathUtil.angleDiff(a: number, b: number): number
	return MathUtil.wrapAngle(b - a)
end

function MathUtil.lerpAngle(a: number, b: number, t: number): number
	return a + MathUtil.angleDiff(a, b) * t
end

-- Exponential soft cap: ~linear for small x, approaches `cap`.
function MathUtil.softCap(x: number, cap: number): number
	if x <= 0 then
		return x
	end
	return cap * (1 - math.exp(-x / cap))
end

function MathUtil.isFiniteNumber(v: any): boolean
	return typeof(v) == "number" and v == v and v ~= math.huge and v ~= -math.huge
end

return MathUtil
