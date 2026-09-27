// @ts-nocheck
//const createEncoder = require("wasm-media-encoders").createEncoder
//import { createEncoder } from "wasm-media-encoders";
//const wasm = require("file-loader!wasm-media-encoders/wasm/mp3.wasm");
//createEncoder("audio/mpeg", wasm).then((encoder) => {/* Now mp3.wasm will be copied to output dir by webpack and fetch()ed at runtime*/});
import { createMp3Encoder as createMp3EncoderFn } from "wasm-media-encoders"
import lamejs from 'lamejs'

const sleep = (ms)=>{
    const p = new Promise((resolve, reject)=>setTimeout(()=>resolve(), ms))
    return p;
}

const mp3Encoder = (samples, opt = { sampleRate: 44100, numChannels: 2, bitrate:192 }) => {
    return mp3EncoderWASM(samples, opt)
    if(opt.numChannels === 2)
        return mp3EncoderStereo(samples, opt)

    return new Promise(async (resolve, reject)=>{

        var left, right;
        var data = samples[0];
        var len = data.length,
            i = 0;
        var dataAsInt16Array = new Int16Array(len);

        while (i < len) {
            dataAsInt16Array[i] = convert(data[i++]);
        }
        function convert(n) {
            var v = n < 0 ? n * 32768 : n * 32767; // convert in range [-32768, 32767]
            return Math.max(-32768, Math.min(32768, v)); // clamp
        }

        samples = dataAsInt16Array;

        let channels = 1; //1 for mono or 2 for stereo
        let sampleRate = opt.sampleRate; //44.1khz (normal mp3 samplerate)
        let kbps = opt.bitrate; //encode 128kbps mp3
        let mp3encoder = new lamejs.Mp3Encoder(channels, sampleRate, kbps);
        var mp3Data = [];
        let sampleBlockSize = 1152; //can be anything but make it a multiple of 576 to make encoders life easier

        var mp3Data = [];
        for (var i = 0; i < samples.length; i += sampleBlockSize) {
            let sampleChunk = samples.subarray(i, i + sampleBlockSize);
            var mp3buf = mp3encoder.encodeBuffer(sampleChunk);
            if (mp3buf.length > 0) {
                
                mp3Data.push(mp3buf);
                self.postMessage({progress:(i/samples.length)*100})// eslint-disable-line no-restricted-globals
                await sleep(2)
            }
        }

        var mp3buf = mp3encoder.flush(); //finish writing mp3

        if (mp3buf.length > 0) {
            mp3Data.push(new Int8Array(mp3buf));
        }

        var blob = new Blob(mp3Data, { type: "audio/mp3" });
        resolve(blob)
    })
};

const mp3EncoderStereo = (samples, opt = { sampleRate: 44100, numChannels: 2, bitrate:192 })=> {

    return new Promise(async (resolve, reject)=>{
        
        var left, right;
        let sampleBlockSize = 1152*16
        let mp3encoder = new lamejs.Mp3Encoder(opt.numChannels, opt.sampleRate, opt.bitrate);
        var mp3Data = [];
        var leftAsInt16Array = new Int16Array(samples[0].length);
        var rightAsInt16Array = new Int16Array(samples[1].length);
        var length = samples[0].length
        let progress = 0

        for (var i = 0; i < samples[0].length;i++)
            leftAsInt16Array[i] = convert(samples[0][i]);
        
        for (var i = 0; i < samples[1].length; i++)
            rightAsInt16Array[i] = convert(samples[1][i]);
        
        function convert(n) {
            var v = n < 0 ? n * 32768 : n * 32767; // convert in range [-32768, 32767]
            return Math.max(-32768, Math.min(32768, v)); // clamp
        }

        for (var i = 0; i < length; i += sampleBlockSize) {
          let leftChunk = leftAsInt16Array.subarray(i, i + sampleBlockSize);
          let rightChunk = rightAsInt16Array.subarray(i, i + sampleBlockSize);
          var mp3buf = mp3encoder.encodeBuffer(leftChunk, rightChunk);
          if (mp3buf.length > 0) {
            mp3Data.push(mp3buf);
            
            const prog = Math.ceil(((i/length)*100))
            if(prog > progress){
                progress = prog;
                self.postMessage({progress}) // eslint-disable-line no-restricted-globals   
                await sleep(2);
            }
          }
        }

        var mp3buf = mp3encoder.flush(); //finish writing mp3

        if (mp3buf.length > 0)
            mp3Data.push(new Int8Array(mp3buf));

        var blob = new Blob(mp3Data, { type: "audio/mp3" });
        resolve(blob)
    })
};

const mp3EncoderWASM = (samples, opt = { sampleRate: 44100, numChannels: 2, bitrate:192 })=>{
    return new Promise((resolve, reject)=>{
        console.log('loading encoder')
        
        createMp3EncoderFn().then(async (encoder) => {
        //createEncoder('audio/mpeg', wasm).then(async (encoder) => {
            console.log('got encoder')
            encoder.configure({
                sampleRate: opt.sampleRate,
                channels: opt.numChannels,
                bitrate: opt.bitrate,
                //vbrQuality:2
            });
            
            const mp3Buff = [];
            const chunkSize = 1024*16*8
            let length = 0;
            let progress = 0

            for (var i = 0; i < samples[0].length; i+=chunkSize) {
                const mp3Data = encoder.encode(sliceBuffer(samples, i, i+(chunkSize)))
                
                if(!mp3Data.length)
                    mp3Buff.push(new Uint8Array(mp3Data))
                else{
                    const copy = new Uint8Array(mp3Data.length)
                    for (var x = 0; x < mp3Data.length; x++)
                        copy[x] = mp3Data[x]
                    mp3Buff.push(copy)
                }
                const prog = Math.ceil(((i+chunkSize)/samples[0].length)*100)
                              
                if(prog > progress){
                    progress = prog;
                    self.postMessage({progress}) // eslint-disable-line no-restricted-globals   
                    await sleep(2);
                }
                
            }
            const endData = encoder.finalize()

            if(endData.length){    
                const copy = new Uint8Array(endData.length)
                for (var x = 0; x < endData.length; x++)
                    copy[x] = endData[x]
                mp3Buff.push(copy)
            }
            else
                 mp3Buff.push(new Uint8Array(endData))  

            self.postMessage({progress:100}) // eslint-disable-line no-restricted-globals
            var blob = new Blob(mp3Buff, { type: "audio/mp3" });
            resolve(blob)

        }).catch((err)=>{
            console.error(err)
        })

        function sliceBuffer(buffer, start, end){
            if(end > buffer[0].length)
                end = buffer[0].length-1

            const rightChunk = new Float32Array(end-start)
            const leftChunk = new Float32Array(end-start)
            for (var i = start, x=0; x < leftChunk.length; x++, i++)
                leftChunk[x] = buffer[0][i]
            for (var i = start, x=0; x < rightChunk.length; x++, i++)
                rightChunk[x] = buffer[0][i]

            return [leftChunk, rightChunk]
        }
        
    })   
}
//module.exports = mp3Encoder;
export default mp3Encoder