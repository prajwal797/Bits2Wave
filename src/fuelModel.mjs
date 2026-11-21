/**
 * ANTARIS Maritime Vessel Fuel Consumption Model
 *
 * Provides realistic vessel fuel consumption calculations based on vessel profiles,
 * speed-power cubic curves, engine ratings, Specific Fuel Consumption (SFC),
 * auxiliary power, fuel density, and sea-ice operational penalties.
 *
 * Features:
 * - Pre-configured vessel profiles (Polar Research Icebreaker, Supply Vessel, Cargo Ship, Custom)
 * - Cubic speed-power physics approximation: P ~ (v / v_ref)^3
 * - Environmental operational penalties based on sea-ice concentration
 * - Explicit estimation labeling (isEstimated: true)
 * - Safe fallback handling (returns status: 'UNAVAILABLE' if parameters are disabled/invalid)
 */

export const VESSEL_PROFILES = Object.freeze({
  polar_icebreaker: Object.freeze({
    id: 'polar_icebreaker',
    name: 'Polar Research Icebreaker',
    cruiseSpeedKnots: 18.0,
    serviceSpeedKnots: 18.0,
    fuelRateLitersPerHour: 1200.0,
    fuelType: 'Marine Gas Oil (MGO)',
    enginePowerKw: 15000,
    ratedPowerKw: 15000,
    baseLoadFraction: 0.85,
    specificFuelConsumptionGPerKWh: 195,
    auxiliaryFuelRateKgPerHour: 120,
    icePenaltyFactor: 0.60,
    fuelDensityKgPerL: 0.85,
    displacementTons: 12500,
  }),
  supply_vessel: Object.freeze({
    id: 'supply_vessel',
    name: 'Polar Supply Vessel',
    cruiseSpeedKnots: 14.0,
    serviceSpeedKnots: 14.0,
    fuelRateLitersPerHour: 750.0,
    fuelType: 'Marine Gas Oil (MGO)',
    enginePowerKw: 8500,
    ratedPowerKw: 8500,
    baseLoadFraction: 0.80,
    specificFuelConsumptionGPerKWh: 205,
    auxiliaryFuelRateKgPerHour: 75,
    icePenaltyFactor: 0.50,
    fuelDensityKgPerL: 0.85,
    displacementTons: 8000,
  }),
  cargo_ship: Object.freeze({
    id: 'cargo_ship',
    name: 'Ice-Class Cargo Ship',
    cruiseSpeedKnots: 12.0,
    serviceSpeedKnots: 12.0,
    fuelRateLitersPerHour: 550.0,
    fuelType: 'Heavy Fuel Oil (HFO)',
    enginePowerKw: 6000,
    ratedPowerKw: 6000,
    baseLoadFraction: 0.75,
    specificFuelConsumptionGPerKWh: 215,
    auxiliaryFuelRateKgPerHour: 50,
    icePenaltyFactor: 0.40,
    fuelDensityKgPerL: 0.95,
    displacementTons: 18000,
  }),
});

/** Default active vessel profile */
export const DEFAULT_VESSEL_PROFILE = VESSEL_PROFILES.polar_icebreaker;

/**
 * Calculate estimated fuel consumption for a route.
 * @param {number} distanceKm - Total route distance in kilometers
 * @param {number|null} [speedKnots] - Vessel speed in knots
 * @param {object|string|boolean|null} [vesselProfile] - Custom or standard vessel profile
 * @param {object} [options] - Additional operational parameters
 * @param {number} [options.averageIceConcentration=0] - Average sea ice concentration (0.0 to 1.0)
 * @returns {object} Calculated fuel metrics or UNAVAILABLE status
 */
export function calculateFuelConsumption(distanceKm, speedKnots = null, vesselProfile = null, options = {}) {
  const dist = Number(distanceKm);
  if (!Number.isFinite(dist) || dist <= 0) {
    return {
      status: 'UNAVAILABLE',
      reason: 'Invalid or zero distance provided',
      estimatedFuelLiters: null,
      estimatedFuelKg: null,
      fuelRateLitersPerHour: null,
      estimatedTravelTimeHours: null,
      fuelPer100Km: null,
      formattedFuelText: 'FUEL UNAVAILABLE',
      isEstimated: false,
    };
  }

  if (vesselProfile === false || vesselProfile === 'disabled') {
    return {
      status: 'UNAVAILABLE',
      reason: 'Vessel fuel configuration disabled',
      estimatedFuelLiters: null,
      estimatedFuelKg: null,
      fuelRateLitersPerHour: null,
      estimatedTravelTimeHours: null,
      fuelPer100Km: null,
      formattedFuelText: 'FUEL UNAVAILABLE',
      isEstimated: false,
    };
  }

  const profile = (typeof vesselProfile === 'object' && vesselProfile !== null)
    ? vesselProfile
    : DEFAULT_VESSEL_PROFILE;

  const serviceSpeed = Number(profile.serviceSpeedKnots || profile.cruiseSpeedKnots || 18.0);
  const speed = (speedKnots !== null && speedKnots !== undefined && Number.isFinite(Number(speedKnots)) && Number(speedKnots) > 0.1)
    ? Number(speedKnots)
    : serviceSpeed;

  const ratedPower = Number(profile.ratedPowerKw || profile.enginePowerKw || 15000);
  const baseLoad = Number(profile.baseLoadFraction || 0.85);
  const sfcGPerKWh = Number(profile.specificFuelConsumptionGPerKWh || 195);
  const auxRateKgH = Number(profile.auxiliaryFuelRateKgPerHour || 120);
  const icePenaltyFactor = Number(profile.icePenaltyFactor || 0.60);
  const fuelDensity = Number(profile.fuelDensityKgPerL || 0.85);

  // Cubic speed-power relationship: P ~ (v / v_ref)^3
  const relSpeed = speed / Math.max(1.0, serviceSpeed);
  const relPower = Math.min(1.20, Math.max(0.08, Math.pow(relSpeed, 3)));
  const propulsionPowerKw = ratedPower * relPower * baseLoad;

  // Travel duration in hours
  const speedKmh = speed * 1.852;
  const travelTimeHours = dist / speedKmh;

  // Fuel component calculations
  const propulsionFuelKg = (propulsionPowerKw * travelTimeHours * sfcGPerKWh) / 1000;
  const auxiliaryFuelKg = auxRateKgH * travelTimeHours;
  const baseFuelKg = propulsionFuelKg + auxiliaryFuelKg;

  // Environmental ice penalty calculation
  const iceConc = Math.max(0, Math.min(1.0, Number(options.averageIceConcentration || options.average_ice_concentration || 0)));
  const icePenaltyKg = propulsionFuelKg * (iceConc * icePenaltyFactor);

  const totalFuelKg = baseFuelKg + icePenaltyKg;
  const totalFuelLiters = totalFuelKg / fuelDensity;
  const fuelRateLph = travelTimeHours > 0 ? totalFuelLiters / travelTimeHours : profile.fuelRateLitersPerHour || 1200;
  const fuelPer100Km = (totalFuelLiters / dist) * 100;

  return {
    status: 'ESTIMATED',
    isEstimated: true,
    vesselType: profile.name || 'Polar Vessel',
    fuelType: profile.fuelType || 'Marine Gas Oil (MGO)',
    distanceKm: Math.round(dist * 10) / 10,
    speedKnots: Math.round(speed * 10) / 10,
    ratedPowerKw: ratedPower,
    propulsionPowerKw: Math.round(propulsionPowerKw),
    estimatedTravelTimeHours: Math.round(travelTimeHours * 10) / 10,
    propulsionFuelKg: Math.round(propulsionFuelKg),
    auxiliaryFuelKg: Math.round(auxiliaryFuelKg),
    icePenaltyKg: Math.round(icePenaltyKg),
    totalFuelKg: Math.round(totalFuelKg),
    estimatedFuelLiters: Math.round(totalFuelLiters),
    fuelRateLitersPerHour: Math.round(fuelRateLph),
    fuelPer100Km: Math.round(fuelPer100Km * 10) / 10,
    formattedFuelText: `${Math.round(totalFuelLiters).toLocaleString()} L`,
    formattedFuelKgText: `${Math.round(totalFuelKg).toLocaleString()} kg`,
    formattedFuelRateText: `${Math.round(fuelRateLph)} L/h`,
    formattedPer100KmText: `${Math.round(fuelPer100Km * 10) / 10} L/100km`,
  };
}
