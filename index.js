const request = require('request');
const dotenv = require('dotenv');
const chron = require('cron');
dotenv.config();

const { 
  PIVOTAL_PROJECT_ID, PIVOTAL_API_TOKEN, 
  SLACK_TOKEN, DAILY_SLACK_CHANNEL, PIVOTAL_USER_ID 
} = process.env;

const newSlackMessageURL = "https://slack.com/api/chat.meMessage"
const storiesURL = `https://www.pivotaltracker.com/services/v5/projects/${PIVOTAL_PROJECT_ID}/stories`

const writeToSlack = (groupedStories) => {

  // don't write to slack if no active stories.
  if(groupedStories.finished.length === 0 && 
     groupedStories.started.length === 0) return
  const message = generateDaily(groupedStories)

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

const getStories = (callback) => {
  const reportedStates = ['finished', 'started']
  const endOfDay = new Date().setHours(0,0,0,0) 
  const beginningOfDay = new Date().setHours(23,59,59,999)

  let groupedStories = {}

  return reportedStates.reduce((requestChain, state) => {
    // perhaps should use filter param.
    const storyParameters = `?with_state=${state}`
    return () => (request.get(storiesURL + storyParameters, {json: true, headers: {
      'X-TrackerToken': PIVOTAL_API_TOKEN
    }}, (err, res, body) => {
      groupedStories[state] = body.filter(({owned_by_id}) => owned_by_id.toString() === PIVOTAL_USER_ID)
      requestChain()
    }))
  }, () => callback(groupedStories))()
}

const formatStory = (story) => (
`*${story.name}*
${story.url}`)

const outlineGroupedStories = (text, stories) => {
  if(stories.length === 0) return ''
  const formmattedStories = stories.map(formatStory)
                                       .join("\n")
  return `${text}
${formmattedStories}`
}

const generateDaily = (groupedStories) => {
  const dateString = new Date().toString().substr(0, 10)

const daily = `${dateString}:

${outlineGroupedStories('Done:', groupedStories.finished)}

${outlineGroupedStories('In Progress:', groupedStories.started)}`

  return daily
}

// getStories(writeToSlack)
var CronJob = chron.CronJob;
const job = new CronJob('00 27 22 * * 1-5', function() {
  console.log('writing daily to slack');
  getStories(writeToSlack)
})

job.start()

