import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

const WS_TTL_S = 3 * 3600; // API Gateway closes WebSocket connections after 2 hours

// Dashboard live updates over API Gateway WebSockets. Connections are kept in the main table.
export function createAwsRealtime({ store, endpoint }) {
  const client = endpoint ? new ApiGatewayManagementApiClient({ endpoint }) : null;

  async function remove(connectionId) {
    const meta = await store.get(`WSCONN#${connectionId}`, 'META');
    if (meta) await store.del(`WS#${meta.pid}`, `CONN#${connectionId}`);
    await store.del(`WSCONN#${connectionId}`, 'META');
  }

  return {
    async add(pid, connectionId) {
      const ttl = Math.floor(Date.now() / 1000) + WS_TTL_S;
      await store.put({ pk: `WS#${pid}`, sk: `CONN#${connectionId}`, connectionId, ttl });
      await store.put({ pk: `WSCONN#${connectionId}`, sk: 'META', pid, ttl });
    },
    remove,
    async publish(pid, event) {
      if (!client) return;
      const conns = await store.query(`WS#${pid}`, { prefix: 'CONN#', limit: 200 });
      const data = Buffer.from(JSON.stringify(event));
      await Promise.all(
        conns.map((c) =>
          client.send(new PostToConnectionCommand({ ConnectionId: c.connectionId, Data: data })).catch((e) => {
            if (e.name === 'GoneException' || e.$metadata?.httpStatusCode === 410) return remove(c.connectionId);
            console.error('ws publish failed', e.name);
          }),
        ),
      );
    },
  };
}

// Delayed jobs (Telegram rate-limit retries) via SQS; the same Lambda consumes the queue.
export function createAwsQueue(queueUrl) {
  const sqs = new SQSClient({});
  return {
    async enqueue(job, delaySeconds = 0) {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(job),
          DelaySeconds: Math.max(0, Math.min(900, Math.ceil(delaySeconds))),
        }),
      );
    },
  };
}
