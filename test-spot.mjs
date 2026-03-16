import { fetchSpotCandles } from './src/services/spot-price.js';

async function test() {
    console.log("Fetching...");
    const res = await fetchSpotCandles('composite::0x2613cb099c12cecb1bd290fd0ef6833949374165+0x4c3b00293070073d71455f20fa9e5868cffd8678::0x89c80a4540a00b5270347e02e2e144c71da2eced-hour-500-xdai', 500, 1763556720);
    console.log("Candles:", res.candles.length);
    if (res.candles.length > 0) {
        console.log("First:", res.candles[0].time);
        console.log("Last:", res.candles[res.candles.length - 1].time);
    }
}
test();
