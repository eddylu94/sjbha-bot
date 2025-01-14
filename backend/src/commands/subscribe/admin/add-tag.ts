import { Message } from 'discord.js';
import { Subscriptions } from '../db/subscription';

export async function add (message: Message) : Promise<void> {
  const role = message.mentions.roles.first ();

  if (!role) {
    message.reply ('Failed to add tag: Missing role to add. Usage: `!subscribe add @role`');

    return;
  }
  
  const sub = await Subscriptions ().findOne ({ id: role.id });
  
  if (sub) {
    message.reply (`Subscription for role '${role.name}' already exists`);

    return;
  }

  await Subscriptions ().insertOne ({
    id:   role.id,
    name: role.name.toLowerCase ()
  });

  message.channel.send (`Added ${role.name} (${role.id}) to subscriptions`);
}