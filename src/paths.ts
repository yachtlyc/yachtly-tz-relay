/**
 * Signal K paths the relay can emit. Mirrors a subset of the dashboard's
 * `app/yachtly-connect/lib/vesselDataMapping.ts` — kept as a local copy so the
 * relay package can be vendored to a nav PC without the main repo.
 *
 * Engine + tank paths are listed but NOT emitted by Phase 1 of the relay —
 * TimeZero's UDP output is navigation-class NMEA 0183 only. See README.
 */

export const SK = {
  positionLat: 'navigation.position.latitude',
  positionLon: 'navigation.position.longitude',
  sog: 'navigation.speedOverGround',
  cog: 'navigation.courseOverGroundTrue',
  headingTrue: 'navigation.headingTrue',
  headingMagnetic: 'navigation.headingMagnetic',
  speedThroughWater: 'navigation.speedThroughWater',
  depthBelowTransducer: 'environment.depth.belowTransducer',
  tripLog: 'navigation.trip.log',
  totalLog: 'navigation.log',
  windAngleApparent: 'environment.wind.angleApparent',
  windSpeedApparent: 'environment.wind.speedApparent',
  windAngleTrue: 'environment.wind.angleTrue',
  windSpeedTrue: 'environment.wind.speedTrue',
  windDirectionTrue: 'environment.wind.directionTrue',
  outsidePressure: 'environment.outside.pressure',
  outsideTemperature: 'environment.outside.temperature',
  outsideHumidity: 'environment.outside.humidity',
  waterTemperature: 'environment.water.temperature',
} as const;

export type SignalKPath = (typeof SK)[keyof typeof SK];
