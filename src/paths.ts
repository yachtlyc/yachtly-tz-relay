/**
 * Signal K paths the relay can emit. Mirrors a subset of the dashboard's
 * `app/yachtly-connect/lib/vesselDataMapping.ts` — kept as a local copy so
 * the relay package can be vendored to a nav PC without the main repo.
 *
 * The `SK` constants below are the navigation-class paths emitted by the
 * NMEA 0183 handlers. N2K paths are dynamic (per engine/tank/battery
 * instance) so they're produced inline by n2kToSignalK.ts as raw strings.
 * Hence `SignalKPath` is widened to `string` — the WS subscribe-filter
 * compares by string equality regardless.
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

export type SignalKPath = string;
