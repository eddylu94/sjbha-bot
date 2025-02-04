import { Collection, MongoClient } from 'mongodb';
import { MONGO_URL } from './env';

type Ref = { instance?: MongoClient; };
const client: Ref = {};

const loader = MongoClient
  .connect (MONGO_URL, { useUnifiedTopology: true })
  .then (r => { client.instance = r; })
  .then (_ => { console.log ('Connected to mongodb'); })
  .catch (_ => { console.warn ('MongoDB failed to connect, some things may not work.\n(Make sure the db is running with \'npm run db\') ', MONGO_URL) })

export const onMongoDbReady : Promise<void> = loader.then (_ => { /** */ });

export function db<T>(name: string) {
  return () : Collection<T> => {
    if (!client.instance) {
      throw new Error ('Mongo DB Client is not connected, yet something tried to access the client. \n(It may be an issue with whitelist for network access - VPN can cause an error connected)');
    }

    return client.instance.db ().collection <T> (name);
  }
}
