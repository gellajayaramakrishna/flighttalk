'use strict';

const os = require('os');
const config = require('./config');
const { createApp } = require('./app');

const { server, useHttps } = createApp();

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

server.listen(config.PORT, config.HOST, () => {
  const proto = useHttps ? 'https' : 'http';
  console.log('');
  console.log('  FlightTalk cabin server is running (no internet needed)');
  console.log(`  Passengers : ${proto}://localhost:${config.PORT}`);
  for (const ip of lanAddresses()) console.log(`               ${proto}://${ip}:${config.PORT}`);
  console.log(`  Crew       : ${proto}://localhost:${config.PORT}/crew.html   PIN ${config.CREW_PIN}`);
  if (!useHttps) {
    console.log('');
    console.log('  HTTP mode: phone cameras need HTTPS. Run `npm run cert` to create data/cert.pem + data/key.pem.');
  }
  console.log('');
});
