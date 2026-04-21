import proj4 from "proj4";
import { cos, sin, pi } from "mathjs";

interface BearingInput {
  distance: number; // in meters
  bearing: number;  // in degrees from north
}

// WGS84 projection
const WGS84 = "EPSG:4326";

function getUTMProjection(zone: string) {
  const zoneNumber = zone.replace(/[^\d]/g, "");

  return `+proj=utm +zone=${zoneNumber} +datum=WGS84 +units=m +no_defs +north`;
}

export function isClosed(coords: number[][], tolerance = 0.01) {
  const first = coords[0];
  const last = coords[coords.length - 1];

  const dx = first[0] - last[0];
  const dy = first[1] - last[1];

  return Math.sqrt(dx * dx + dy * dy) < tolerance;
}

// ✅ LatLng → UTM
export function latLngToUTM(lat: number, lng: number, zone: string): [number, number] {
  const utm = getUTMProjection(zone);
  const [easting, northing] = proj4(WGS84, utm, [lng, lat]);
  return [easting, northing];
}

// ✅ UTM → LatLng
export function utmToLatLng(
  easting: number,
  northing: number,
  zone: string
): [number, number] {
  const utm = getUTMProjection(zone);

  const [lng, lat] = proj4(utm, "EPSG:4326", [easting, northing]);

  return [lat, lng];
}

// ✅ Calculate area using shoelace formula (accurate for UTM coordinates)
export function calculateAreaFromUTM(utmCoordinates: number[][]): number {
  if (utmCoordinates.length < 3) return 0;

  let area = 0;
  const n = utmCoordinates.length;

  for (let i = 0; i < n; i++) {
    const [x1, y1] = utmCoordinates[i];
    const [x2, y2] = utmCoordinates[(i + 1) % n];
    area += x1 * y2 - x2 * y1;
  }

  return Math.abs(area) / 2; // Shoelace formula gives 2x area
}

// Example: UTM zones in Nigeria (32N, 31N)
export function convertUTMToLatLng(
  easting: number,
  northing: number,
  zone: string,
  toUTM = false
): [number, number] {
  // Define UTM projection string for zone

    const zoneNumber = zone.replace(/[^\d]/g, "");
  const isSouth = zone.toUpperCase().includes("S");
  const utmProj = `+proj=utm +zone=${zoneNumber} ${isSouth ? "+south" : ""} +datum=WGS84 +units=m +no_defs`;
  
  if (toUTM) {
    // LatLng -> UTM: easting=lat, northing=lng, so pass [lng, lat]
    return proj4(WGS84, utmProj, [northing, easting]) as [number, number];
  } else {
    // UTM -> LatLng
    return proj4(utmProj, WGS84, [easting, northing]) as [number, number];
  }
}




export function bearingsToCoordinates(
  bearings: BearingInput[],
  utmZone: string,
  startPoint: [number, number] = [0, 0], // UTM coordinates [easting, northing]
  isUTM: boolean = true // Default to UTM for Nigerian surveys
): { latlngCoordinates: number[][]; utmCoordinates: number[][] } {

  // Convert start point to UTM if needed
  let currentUTM = isUTM
    ? startPoint
    : latLngToUTM(startPoint[0], startPoint[1], utmZone);

  const utmCoordinates: number[][] = [currentUTM];

  for (const { distance, bearing } of bearings) {
    // Convert bearing to radians (clockwise from north)
    const theta = (bearing * Math.PI) / 180;

    // Calculate deltas in UTM space (meters)
    const deltaE = distance * Math.sin(theta);
    const deltaN = distance * Math.cos(theta);

    currentUTM = [
      currentUTM[0] + deltaE,
      currentUTM[1] + deltaN
    ];

    utmCoordinates.push(currentUTM);
  }

  // Convert all UTM back to lat/lng
  const latlngCoordinates = utmCoordinates.map(([easting, northing]) =>
    utmToLatLng(easting, northing, utmZone)
  );

  return { latlngCoordinates, utmCoordinates };
}