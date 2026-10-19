import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';

// Single-table store. Every item has `pk` + `sk`; GSI1 (gsi1pk/gsi1sk) lists projects per owner.
export function createDynamoStore(tableName) {
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });

  return {
    async get(pk, sk) {
      const r = await db.send(new GetCommand({ TableName: tableName, Key: { pk, sk } }));
      return r.Item ?? null;
    },

    async put(item, { ifNotExists = false } = {}) {
      try {
        await db.send(
          new PutCommand({
            TableName: tableName,
            Item: item,
            ...(ifNotExists ? { ConditionExpression: 'attribute_not_exists(pk)' } : {}),
          }),
        );
        return true;
      } catch (e) {
        if (e.name === 'ConditionalCheckFailedException') return false;
        throw e;
      }
    },

    async update(pk, sk, { set = {}, remove = [], add = {} } = {}) {
      const names = {};
      const values = {};
      const setParts = [];
      const addParts = [];
      let i = 0;
      for (const [k, v] of Object.entries(set)) {
        if (v === undefined) continue;
        names[`#n${i}`] = k;
        values[`:v${i}`] = v;
        setParts.push(`#n${i} = :v${i}`);
        i++;
      }
      for (const [k, v] of Object.entries(add)) {
        names[`#n${i}`] = k;
        values[`:v${i}`] = v;
        addParts.push(`#n${i} :v${i}`);
        i++;
      }
      const removeParts = remove.map((k) => {
        names[`#n${i}`] = k;
        return `#n${i++}`;
      });
      const expr = [
        setParts.length && `SET ${setParts.join(', ')}`,
        addParts.length && `ADD ${addParts.join(', ')}`,
        removeParts.length && `REMOVE ${removeParts.join(', ')}`,
      ]
        .filter(Boolean)
        .join(' ');
      const r = await db.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { pk, sk },
          UpdateExpression: expr,
          ExpressionAttributeNames: names,
          ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
          ReturnValues: 'ALL_NEW',
        }),
      );
      return r.Attributes;
    },

    async query(pk, { prefix, after, desc = false, limit = 50 } = {}) {
      let cond = 'pk = :pk';
      const values = { ':pk': pk };
      if (after) {
        cond += ' AND sk > :after';
        values[':after'] = after;
      } else if (prefix) {
        cond += ' AND begins_with(sk, :prefix)';
        values[':prefix'] = prefix;
      }
      const r = await db.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: cond,
          ExpressionAttributeValues: values,
          ScanIndexForward: !desc,
          Limit: limit,
        }),
      );
      return r.Items ?? [];
    },

    async queryIndex(gsi1pk, { limit = 100 } = {}) {
      const r = await db.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: 'gsi1',
          KeyConditionExpression: 'gsi1pk = :pk',
          ExpressionAttributeValues: { ':pk': gsi1pk },
          ScanIndexForward: false,
          Limit: limit,
        }),
      );
      return r.Items ?? [];
    },

    async del(pk, sk) {
      await db.send(new DeleteCommand({ TableName: tableName, Key: { pk, sk } }));
    },
  };
}
