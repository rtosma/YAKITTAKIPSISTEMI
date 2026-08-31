import mqtt from 'mqtt';

const client = mqtt.connect('mqtt://localhost:1883');

client.on('connect', () => {
  console.log('Connected to local EMQX broker');

  // Simulate an LWT (Status) message
  const statusTopic = 'telemetry/v1/tenant1/site1/pump/pump-01/status';
  client.publish(statusTopic, 'OFFLINE', { qos: 1 });
  console.log(`Published OFFLINE to ${statusTopic}`);

  // Simulate a Data message
  const dataTopic = 'telemetry/v1/tenant1/site1/pump/pump-01/data';
  const payload = JSON.stringify({ flowRate: 45.2, totalVolume: 1020.5 });
  client.publish(dataTopic, payload, { qos: 1 });
  console.log(`Published Data to ${dataTopic}`);

  setTimeout(() => {
    client.end();
    console.log('Done.');
  }, 1000);
});
