declare module "zipcodes" {
  export type ZipCode = { zip: string; latitude: number; longitude: number; city: string; state: string; country: string };
  const zipcodes: { codes: Record<string, ZipCode>; lookup(zip: string | number): ZipCode | undefined; distance(a: string | number, b: string | number): number | null };
  export default zipcodes;
}
