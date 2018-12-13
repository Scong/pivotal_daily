const request = require('request');
const dotenv = require('dotenv');
const chron = require('cron');
const { reverse, map, groupBy, last } = require('lodash')
dotenv.config();

const { 
  PIVOTAL_PROJECT_ID, PIVOTAL_API_TOKEN, 
  SLACK_TOKEN, DAILY_SLACK_CHANNEL, PIVOTAL_USER_ID 
} = process.env;

const newSlackMessageURL = "https://slack.com/api/chat.meMessage"
const snapshotsURL = `https://www.pivotaltracker.com/services/v5/projects/${PIVOTAL_PROJECT_ID}/history/snapshots`
const storiesURL = `https://www.pivotaltracker.com/services/v5/projects/${PIVOTAL_PROJECT_ID}/stories`
const activityURL = `https://www.pivotaltracker.com/services/v5/my/activity`

const writeToSlack = (message) => {
  const messageBody = {
    channel: DAILY_SLACK_CHANNEL,
    text: message
  }

  return request.post(newSlackMessageURL, {json: true, 
      headers: {
        Authorization: `Bearer ${SLACK_TOKEN}` 
      },
      body: messageBody
    }, (err, res, body) => {
    if (err) { return console.log(err); }
    console.log(body);
  })
};

const getStoryResource = (activity) => {
  return activity.primary_resources.find((resource) => {
    return resource.kind === 'story'
  })
}

const isReportedComment = (commentValue) => {
  return commentValue.includes("note:")
}

const getChangeCommentType = (resource) => {
  return resource.new_values.text
}

const reportedCommentValue = (activity) => {
  const commentObj = activity.changes.find((resource) => {
    if(resource.kind === 'comment') {
      const commentText = getChangeCommentType(resource)
      return commentText.includes('<=>')
    }
  })

  if(!commentObj) return null
  return getChangeCommentType(commentObj).replace(/<=>/gi, '')
}

const wasRejectedStory = (activity) => {
  return !!activity.changes.find((resource) => {
    if(resource.kind === 'story') {
      return resource.original_values && resource.original_values.current_state === 'rejected'
    }
  })
}

const groupStories = (activityData) => {
  return reverse(activityData).reduce((groupedData, activity) => {
    if(activity.kind === 'story_update_activity' || activity.kind === 'story_create_activity') {
      const storyResource = getStoryResource(activity)
      groupedData[storyResource.id] = groupedData[storyResource.id] || storyResource
      groupedData[storyResource.id].transitions = groupedData[storyResource.id].transitions || []
      if(wasRejectedStory(activity)) groupedData[storyResource.id].transitions.push('rejected')
      groupedData[storyResource.id].transitions.push(activity.highlight)
    } else if(activity.kind === 'comment_create_activity' || 
              activity.kind === 'comment_update_activity') {
      const storyResource = getStoryResource(activity)
      const commentValue = reportedCommentValue(activity)
      if(storyResource && commentValue) {
        groupedData[storyResource.id] = groupedData[storyResource.id] || storyResource
        groupedData[storyResource.id].comment = commentValue
      }
    }
    return groupedData
  }, {})
}

const getStoryData = (callback, date = new Date()) => {
  const isoDate = new Date(date.setHours(0,0,0,0)).toISOString()
  const beginningOfDay = date.setHours(0,0,0,0) 
  const endOfDay = date.setHours(23,59,59,999)

  const activityParameters = `?occurred_before=${endOfDay}&occurred_after=${beginningOfDay}`
  const snapshotParameters = `?start_date=${isoDate}&end_date=${isoDate}`
  request.get(activityURL + activityParameters, {json: true, headers: {
    'X-TrackerToken': PIVOTAL_API_TOKEN
  }}, (err, res, activityData) => {
    request.get(snapshotsURL + snapshotParameters, {json: true, headers: {
      'X-TrackerToken': PIVOTAL_API_TOKEN
    }}, (err, res, snapshotData) => {
      const fetchedSnapshot = (snapshotData[0] && snapshotData[0].current) || []
      const storyIds = (fetchedSnapshot.map((snap) => snap.story_id)).join(',')
      const storiesParameters = `?filter=id:${storyIds} owner:${PIVOTAL_USER_ID}`
      request.get(storiesURL + storiesParameters, {json: true, headers: {
        'X-TrackerToken': PIVOTAL_API_TOKEN
      }}, (err, res, stories) => {
        const filteredActivityData = activityData.filter((activity) => 
          String(activity.project.id) === PIVOTAL_PROJECT_ID)
        
        const groupedStoriesFromActivityData = groupStories(filteredActivityData)
        let groupedStories = groupedStoriesFromActivityData
        if(stories.length > 0 && fetchedSnapshot.length > 0) {
          stories.forEach((story) => {
            const snapshot = fetchedSnapshot.find((snap) => snap.story_id === story.id)
            if(snapshot.state === 'finished' ||
              snapshot.state === 'started' || 
              snapshot.state === 'rejected') {
              groupedStories[story.id] = groupedStories[story.id] || {}
              groupedStories[story.id].state = snapshot.state
              groupedStories[story.id].name = story.name
              groupedStories[story.id].url = story.url
            }
            groupedStories
          })
        }
        callback(generateDaily(groupedStories, date))
      })
    })
  })
}

const formatStory = (story) => (
`*${story.name}*
${(story.comment && story.comment + "\n") || ""}${story.url}`)

const outlineGroupedStories = (text, stories) => {
  if(stories.length === 0) return ''
  const formmattedStories = stories.map(formatStory)
                                       .join("\n")
  return `${text}
${formmattedStories}`
}

const translations = {
  reworked_done: "Reworked Done:",
  reworked_in_progress: "Reworked In Progress:",
  rejected: "Rejected:",
  finished: "Done:",
  started: "In Progress:",
  added: "Created:",
  uncategorized: "Uncategorized:"
}

const storyGrouper = (story) => {
  if(!story.transitions && story.state) {
    return story.state
  } else if(!story.transitions && !story.state){
    console.log('Uncategorized story Warning: ', story)
    return 'uncategorized'
  } else if(story.transitions.includes('rejected') 
     && (last(story.transitions) === 'finished')
         ||  last(story.transitions) === 'accepted'){
    return 'reworked_done'
  } else if(story.transitions.includes('rejected') 
            && last(story.transitions) === 'started'){
    return 'reworked_in_progress'
  } else if(last(story.transitions) === 'rejected') {
    return 'rejected'
  } else if(last(story.transitions) === 'finished' || 
            last(story.transitions) === 'accepted') {
    return 'finished'
  } else if(last(story.transitions) === 'started') {
    return 'finished'
  } else if(last(story.transitions) === 'added') {
    return 'added'
  } else {
    return 'uncategorized'
  }
}

const generateDaily = (storyData, date) => {
  const dateString = date.toString().substr(0, 10)

  
  const outlinedStories = map(groupBy(storyData, storyGrouper), (value, key) => {
    return outlineGroupedStories(translations[key], value)
  }).join('\n\n')

const daily = `${dateString}:

${outlinedStories}`
  return daily
}

module.exports.generate = (date) => getStoryData((message) => console.log(message), date)

module.exports.init = (date = new Date()) => {
  var CronJob = chron.CronJob;
  const job = new CronJob('00 27 22 * * 1-5', function() {
    console.log('writing daily to slack');
    getStoryData(writeToSlack, date)
  })
  
  job.start()
}


