import { EmbedField, MessageEmbed } from 'discord.js';
import { Interval, DateTime, Duration } from 'luxon';
import { Just, Maybe, Nothing } from 'purify-ts';
import { isType, just, match } from 'variant';

import { Instance } from '@sjbha/app';
import { channels } from '@sjbha/config';

import { 
  StravaClient, 
  Activity, 
  StreamResponse 
} from '../common/StravaClient';

import * as User from '../db/user';
import * as Workout from '../db/workout';
import { activityEmoji } from '../common/activity-emoji';


/**
 * When a new workout gets recorded we post it to the #strava channel.
 * This function will:
 * 
 * 1. Calculate the amount of EXP gained from the activity
 * 2. Save the workout as a log
 * 3. Post it to #strava
 *
 * If the workout has already been posted once, the previous message will get edited instead
 */
export const postWorkout = async (stravaId: number, activityId: number) : Promise<void> => {
  // Find the user it belongs to
  const user = await User.findOne ({ stravaId });

  if (!user || !('refreshToken' in user)) {
    throw new Error ('Could not post workout: User is not authorized (strava ID: ' + stravaId + ')');
  }

  const client = await StravaClient.authenticate (user.refreshToken);

  // Fetch all the data we need
  const [member, workouts, activity, streams] = await Promise.all ([
    Instance.findMember (user.discordId),
    Workout.find (
      { discord_id: user.discordId },
      Interval.before (DateTime.local (), { days: 30 })
    ),
    client.getActivity (activityId),
    client.getActivityStreams (activityId).catch (_ => [])
  ]);

  // Create the workout
  const exp = calculateExp (user.maxHR, activity, streams);
  const weeklyExp = expTotal (exp) + workouts
    .filter (w => w.activity_id !== activity.id)
    .map (w => expTotal (w.exp))
    .reduce ((sum, exp) => sum + exp, 0);

  // Build the Embed
  const embed = new MessageEmbed ()
    .setColor (member.displayColor)
    .setAuthor (activityEmoji (activity, user.gender) + ' ' + member.displayName + ' ' + justDid (activity))
    .setThumbnail (member.user.displayAvatarURL ())
    .setDescription (activity.description)
    .addFields (activityStats (activity))
    .setFooter (gainedText (exp) + ' | ' + format.exp (weeklyExp) + ' exp this week');

  // Check if workout has been recorded already
  const previouslyRecorded = workouts.find (workout => workout.activity_id === activity.id);

  // Update if exists
  if (previouslyRecorded) {
    await Instance.editMessage (
      channels.strava, 
      previouslyRecorded.message_id, 
      embed
    );

    await Workout.update ({
      ...previouslyRecorded,
      activity_name: activity.name,
      exp:           exp
    });
  }
  // Create new workout if doesn't
  else {
    const message = await Instance.broadcast (channels.strava, embed);
    await Workout.insert ({
      discord_id:    user.discordId,
      activity_id:   activity.id,
      message_id:    message.id,
      activity_name: activity.name,
      timestamp:     activity.start_date,
      activity_type: activity.type,
      exp:           exp      
    });
  }
}


/**
 * Calculate the amount of EXP gained from a workout.
 * 
 * If the user has their Max heartrate set and the activity was recorded with an HR compatible device,
 *   the user will get 1 exp for every second in Moderate (max heartrate x 0.5)
 *   and 2 exp for every second in Vigorous (max heartrate x 0.75)
 * 
 * If there is no heart rate data available, the calculation defaults to 1exp per second of moving time
 * 
 * @param maxHeartrate The user's set max heart rate
 * @param activity Activity data from strava
 * @param streams Samples of the users heart rate data from the recording
 * @returns Calculated result of either HR Exp or Time based Exp
 */
const calculateExp = (maxHeartrate: number | undefined, activity: Activity, streams: StreamResponse) : Workout.Exp => {
  const hr = Maybe
    .fromNullable (streams.find (s => s.type === 'heartrate'))
    .mapOrDefault (s => s.data, []);

  const time = Maybe
    .fromNullable (streams.find (s => s.type === 'time'))
    .mapOrDefault (s => s.data, []);

  if (maxHeartrate && hr.length && time.length) {
    const moderate = maxHeartrate * 0.5;
    const vigorous = maxHeartrate * 0.75;
    let moderateSeconds = 0;
    let vigorousSeconds = 0;

    for (let i = 0; i < hr.length; i++) {
      const bpm = hr[0];
      const seconds = (time[i + 1])
        ? (time[i + 1] - time[i])
        : 0;

      if (bpm >= vigorous) {
        moderateSeconds += seconds;
      }
      else if (bpm >= moderate) {
        vigorousSeconds += seconds;
      }
    }

    return Workout.Exp.hr (moderateSeconds, vigorousSeconds * 2);
  }
  else {
    const minutes = Duration
      .fromObject ({ seconds: activity.moving_time })
      .as ('minutes');

    return Workout.Exp.time (minutes);
  }
}


/**
 * Formatting of the footer text that shows how much EXP was gained from this workout
 * 
 * @param exp 
 * @returns The string to place in the footer
 */
const gainedText = (exp: Workout.Exp) => {
  const total = `Gained ${format.exp (expTotal (exp))}`;
  
  return match (exp, {
    hr:   ({ moderate, vigorous }) => total + ` exp (${format.exp (moderate)}+ ${format.exp (vigorous)}++)`,
    time: _ => total
  });
}


/**
 * Calculates the total EXP.
 * 
 * @returns The number of Exp gained
 */
const expTotal = (exp: Workout.Exp) => match (exp, {
  hr:   h => h.moderate + h.vigorous,
  time: t => t.exp
});


/**
 * Formats the part in the title with "just did xx"
 * 
 * @returns The string to use in the title
 */
const justDid = (activity: Activity) : string => match (activity, {
  Ride:     just ('just went for a ride'),
  Run:      just ('just went for a run'),
  Yoga:     just ('just did some yoga'),
  Hike:     just ('just went on a hike'),
  Walk:     just ('just went on a walk'),
  Workout:  just ('just did a workout'),
  Crossfit: just ('just did crossfit'),

  RockClimbing:   just ('just went rock climbing'),
  WeightTraining: just ('just lifted some weights'),
  
  default: just ('Just recorded a ' + activity.type)
});


/**
 * Different activities have different activity stats that are worth showing.
 * We'll figure out which ones to show here, otherwise default to heartrate stats (if available)
 * 
 * @param activity 
 * @returns An array of fields to use in the embed
 */
const activityStats = (activity: Activity) : EmbedField[] => {
  // Quick util to make a field
  const field = <A>(name: string, value: (a: A) => string) => 
    (a: A) : EmbedField => ({ name, value: value (a), inline: true });

  const hr = (activity.has_heartrate)
    ? Just (activity)
    : Nothing;

  const averageHeartrate = hr.map (field ('Avg HR', a => format.hr (a.average_heartrate)));
  const maxHeartrate = hr.map (field ('Max HR', a => format.hr (a.max_heartrate)));
  const heartrate = Maybe.sequence ([averageHeartrate, maxHeartrate]);

  const gps = Just (activity).filter (a => a.distance > 0);
  const distance = gps.map (field ('Distance', a => format.miles (a.distance)));
  const elevation = gps.map (field ('Elevation', a => format.feet (a.total_elevation_gain)));
  const pace = gps.map (field ('Pace', a => format.pace (a.average_speed)));

  return [
    { name: 'Elapsed', value: format.duration (activity.elapsed_time), inline: true },
    ...match (activity, {
      Run: _ => 
        Maybe.sequence ([distance, pace])
          .alt (heartrate)
          .orDefault ([]),

      Hike: _ => 
        Maybe.sequence ([distance, elevation])
          .alt (heartrate)
          .orDefault ([]),

      Ride: _ => 
        Maybe.sequence ([distance, elevation])
          .alt (heartrate)
          .orDefault ([]),
      
      Walk: _ =>
        Maybe.catMaybes ([distance, averageHeartrate]),

      Yoga: _ =>
        heartrate.orDefault ([]),

      default: () => heartrate.orDefault ([])
    })
  ];
}


/**
 * Format conversions to use in the embed
 */
const format = {
  hr: (bpm: number) => Math.floor (bpm).toString (),

  miles: (meters: number) => (meters * 0.000621371192).toFixed (2) + 'mi',

  feet: (meters: number) => (meters * 3.2808399).toFixed (0) + 'ft',

  duration: (seconds: number) => {
    const d = Duration.fromObject ({ seconds });
    
    if (d.as ('hours') > 1) 
      return d.toFormat ('h\'h\' mm\'m\'');
    else if (d.as ('minutes') > 0) 
      return d.toFormat ('m\'m\' ss\'s\'');
    else
      return d.toFormat ('s\'s\'');
  },

  pace: (ms: number) => {
    const t = Duration.fromObject ({
      minutes: (26.8224 / ms)
    });

    return (t.as ('hours') > 1)
      ? t.toFormat ('hh:mm:ss')
      : t.toFormat ('mm:ss');
  },

  exp: (amt: number) => 
    (amt >= 1000) ? (amt / 1000).toFixed (2) + 'k'
    : amt.toFixed (2)
};